import * as vscode from "vscode";
import { getAppSession } from "../app-auth.js";
import { parseAppSessionClaims } from "./session-user.js";
import { loadStoredDek } from "./dek-storage.js";
import {
  fetchServerKeyMaterial,
  getCachedKeysGate,
  invalidateKeysGateCache,
  type KeysGateCache,
} from "./keys-client.js";

export type E2eGatePhase =
  | "no_app_session"
  | "email_not_verified"
  | "keys_not_set"
  | "locked"
  | "unlocked";

export interface E2eGateSnapshot {
  phase: E2eGatePhase;
  userId?: string;
  keyVersion?: number;
}

let cachedSnapshot: E2eGateSnapshot | undefined;

export function invalidateE2eGateSnapshot(): void {
  cachedSnapshot = undefined;
}

export async function resolveE2eGateSnapshot(
  context: vscode.ExtensionContext,
  options?: { refreshKeys?: boolean; bypassCache?: boolean }
): Promise<E2eGateSnapshot> {
  if (!options?.refreshKeys && !options?.bypassCache && cachedSnapshot) {
    return cachedSnapshot;
  }

  const session = await getAppSession(context);
  if (!session) {
    cachedSnapshot = { phase: "no_app_session" };
    return cachedSnapshot;
  }

  const claims = parseAppSessionClaims(session);
  if (!claims) {
    cachedSnapshot = { phase: "no_app_session" };
    return cachedSnapshot;
  }

  if (!claims.emailVerified) {
    cachedSnapshot = { phase: "email_not_verified", userId: claims.userId };
    return cachedSnapshot;
  }

  let keysCache: KeysGateCache = getCachedKeysGate();
  if (keysCache.presence === "unknown" || options?.refreshKeys) {
    keysCache = await fetchServerKeyMaterial(context, { force: options?.refreshKeys });
  }

  if (keysCache.presence === "not_set") {
    cachedSnapshot = { phase: "keys_not_set", userId: claims.userId };
    return cachedSnapshot;
  }

  const keyVersion = keysCache.keyMaterial?.keyVersion ?? 1;
  const dek = await loadStoredDek(context, claims.userId, keyVersion);
  if (!dek) {
    cachedSnapshot = { phase: "locked", userId: claims.userId, keyVersion };
    return cachedSnapshot;
  }

  cachedSnapshot = { phase: "unlocked", userId: claims.userId, keyVersion };
  return cachedSnapshot;
}

export async function refreshE2eGateContext(
  context: vscode.ExtensionContext,
  options?: { refreshKeys?: boolean }
): Promise<E2eGateSnapshot> {
  const snapshot = await resolveE2eGateSnapshot(context, options);
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.e2e.unlocked",
    snapshot.phase === "unlocked"
  );
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.e2e.locked",
    snapshot.phase === "locked" || snapshot.phase === "keys_not_set"
  );
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.e2e.needsSetup",
    snapshot.phase === "keys_not_set"
  );
  return snapshot;
}

export async function requireE2eUnlocked(
  context: vscode.ExtensionContext
): Promise<
  | { ok: true; userId: string; keyVersion: number; dek: Buffer }
  | { ok: false; message: string }
> {
  const snapshot = await resolveE2eGateSnapshot(context);
  if (snapshot.phase === "no_app_session") {
    return { ok: false, message: "Log in to Cursor Sync to use encrypted sync." };
  }
  if (snapshot.phase === "email_not_verified") {
    return { ok: false, message: "Verify your email before using encrypted sync." };
  }
  if (snapshot.phase === "keys_not_set") {
    return {
      ok: false,
      message: "Create a sync passphrase to enable encrypted sync (Cursor Sync: Unlock).",
    };
  }
  if (snapshot.phase === "locked" || !snapshot.userId || !snapshot.keyVersion) {
    return { ok: false, message: "Sync is locked. Unlock with your passphrase or recovery key." };
  }
  const dek = await loadStoredDek(context, snapshot.userId, snapshot.keyVersion);
  if (!dek) {
    invalidateE2eGateSnapshot();
    return { ok: false, message: "Sync is locked. Unlock with your passphrase or recovery key." };
  }
  return { ok: true, userId: snapshot.userId, keyVersion: snapshot.keyVersion, dek };
}

export function onAppSessionCleared(): void {
  invalidateKeysGateCache();
  invalidateE2eGateSnapshot();
}

export async function lockLocalDek(context: vscode.ExtensionContext): Promise<void> {
  const snapshot = cachedSnapshot;
  if (snapshot?.userId && snapshot.keyVersion) {
    const { clearStoredDekForUser } = await import("./dek-storage.js");
    await clearStoredDekForUser(context, snapshot.userId, snapshot.keyVersion);
  }
  invalidateE2eGateSnapshot();
  await refreshE2eGateContext(context);
}
