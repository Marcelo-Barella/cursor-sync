import * as vscode from "vscode";
import { getAppSession } from "../app-auth.js";
import { parseAppSessionClaims } from "./session-user.js";
import { clearStoredDekForUser, loadStoredDek } from "./dek-storage.js";
import {
  fetchServerKeyMaterial,
  getCachedKeysGate,
  hasVerifiedKeysCacheForOfflineUnlock,
  hydrateKeysCacheFromDisk,
  invalidateKeysGateCache,
  keysCacheNeedsRefresh,
  KeysApiError,
  type KeysGateCache,
} from "./keys-client.js";
import {
  isTransientNetworkError,
  logConnectivityFailure,
  userFriendlyConnectivityMessage,
} from "./network-errors.js";
import type { ServerKeyMaterialResponse } from "./keys-wire.js";
import { refreshSyncStatusBar } from "../sync-status-bar.js";

export const E2E_LOCKED_SYNC_MESSAGE =
  "Sync is locked. Unlock with your passphrase or recovery key.";

export type E2eGatePhase =
  | "no_app_session"
  | "email_not_verified"
  | "keys_not_set"
  | "locked"
  | "unlocked"
  | "keys_unavailable";

export interface E2eGateSnapshot {
  phase: E2eGatePhase;
  userId?: string;
  keyVersion?: number;
  keysStatusMessage?: string;
  keysGateForCrypto?: {
    material: ServerKeyMaterialResponse;
    usedOfflineKeysCache: boolean;
  };
}

let cachedSnapshot: E2eGateSnapshot | undefined;

export function invalidateE2eGateSnapshot(): void {
  cachedSnapshot = undefined;
}

export async function refreshE2eGateOnActivation(
  context: vscode.ExtensionContext
): Promise<E2eGateSnapshot> {
  await hydrateKeysCacheFromDisk(context);
  const disk = getCachedKeysGate();
  const refreshKeys = keysCacheNeedsRefresh(disk);
  return refreshE2eGateContext(context, { bypassCache: true, refreshKeys });
}

export async function refreshE2eGateAfterCryptoChange(
  context: vscode.ExtensionContext,
  options?: { refreshKeys?: boolean }
): Promise<E2eGateSnapshot> {
  invalidateE2eGateSnapshot();
  const snapshot = await refreshE2eGateContext(context, {
    bypassCache: true,
    refreshKeys: options?.refreshKeys ?? false,
  });
  await refreshSyncStatusBar(context);
  return snapshot;
}

function keysGateForCryptoFromCache(
  keysCache: KeysGateCache,
  usedOfflineKeysCache: boolean
): E2eGateSnapshot["keysGateForCrypto"] | undefined {
  if (!keysCache.keyMaterial) {
    return undefined;
  }
  return { material: keysCache.keyMaterial, usedOfflineKeysCache };
}

export async function resolveE2eGateSnapshot(
  context: vscode.ExtensionContext,
  options?: { refreshKeys?: boolean; bypassCache?: boolean; skipNetwork?: boolean }
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

  await hydrateKeysCacheFromDisk(context);

  const diskCache = getCachedKeysGate();
  let keysCache: KeysGateCache = diskCache;
  let usedOfflineKeysCache = false;
  let freshKeysFromServer = false;
  const forceKeysFetch =
    options?.refreshKeys === true || keysCacheNeedsRefresh(diskCache);
  try {
    const fetchResult = await fetchServerKeyMaterial(context, {
      force: forceKeysFetch,
      skipNetwork: options?.skipNetwork,
    });
    keysCache = fetchResult.cache;
    freshKeysFromServer = fetchResult.fetchedFromNetwork;
  } catch (err) {
    if (err instanceof KeysApiError && err.status === 401) {
      const { markAppSessionExpired } = await import("../app-auth.js");
      await markAppSessionExpired(context);
      cachedSnapshot = { phase: "no_app_session" };
      return cachedSnapshot;
    }
    if (err instanceof KeysApiError && (err.status === 429 || err.status >= 500)) {
      cachedSnapshot = {
        phase: "keys_unavailable",
        userId: claims.userId,
        keysStatusMessage: err.message,
      };
      return cachedSnapshot;
    } else if (isTransientNetworkError(err)) {
      if (hasVerifiedKeysCacheForOfflineUnlock(diskCache)) {
        keysCache = diskCache;
        usedOfflineKeysCache = true;
      } else {
        const keysStatusMessage = userFriendlyConnectivityMessage(err);
        logConnectivityFailure(keysStatusMessage);
        cachedSnapshot = {
          phase: "keys_unavailable",
          userId: claims.userId,
          keysStatusMessage,
        };
        return cachedSnapshot;
      }
    } else {
      const keysStatusMessage = userFriendlyConnectivityMessage(err);
      logConnectivityFailure(keysStatusMessage);
      cachedSnapshot = {
        phase: "keys_unavailable",
        userId: claims.userId,
        keysStatusMessage,
      };
      return cachedSnapshot;
    }
  }

  if (
    !options?.refreshKeys &&
    keysCache.verification === "email_not_verified" &&
    diskCache.verification === "verified"
  ) {
    keysCache = diskCache;
  }

  if (keysCache.verification === "email_not_verified") {
    cachedSnapshot = { phase: "email_not_verified", userId: claims.userId };
    return cachedSnapshot;
  }

  if (keysCache.presence === "not_set") {
    cachedSnapshot = { phase: "keys_not_set", userId: claims.userId };
    return cachedSnapshot;
  }

  const keyVersion = keysCache.keyMaterial?.keyVersion ?? 1;
  const keysGateForCrypto =
    freshKeysFromServer || usedOfflineKeysCache
      ? keysGateForCryptoFromCache(keysCache, usedOfflineKeysCache)
      : undefined;
  const dek = await loadStoredDek(context, claims.userId, keyVersion);
  if (!dek) {
    cachedSnapshot = {
      phase: "locked",
      userId: claims.userId,
      keyVersion,
      keysGateForCrypto,
    };
    return cachedSnapshot;
  }

  cachedSnapshot = {
    phase: "unlocked",
    userId: claims.userId,
    keyVersion,
    keysGateForCrypto,
  };
  return cachedSnapshot;
}

async function applyE2eGateSnapshotToContext(snapshot: E2eGateSnapshot): Promise<void> {
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
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.e2e.emailNotVerified",
    snapshot.phase === "email_not_verified"
  );
}

export async function refreshE2eGateContext(
  context: vscode.ExtensionContext,
  options?: { refreshKeys?: boolean; bypassCache?: boolean; skipNetwork?: boolean }
): Promise<E2eGateSnapshot> {
  const snapshot = await resolveE2eGateSnapshot(context, options);
  cachedSnapshot = snapshot;
  await applyE2eGateSnapshotToContext(snapshot);
  return snapshot;
}

export type E2eDekUnlocked = {
  ok: true;
  kind: "dek";
  userId: string;
  keyVersion: number;
  dek: Buffer;
};

export type E2eUnlockedResult =
  | E2eDekUnlocked
  | { ok: true; kind: "gist_plaintext" }
  | { ok: false; message: string };

export function isE2eDekUnlocked(result: E2eUnlockedResult): result is E2eDekUnlocked {
  return result.ok === true && result.kind === "dek";
}

const APP_LOGIN_REQUIRED_MESSAGE = "Log in to Cursor Sync to use encrypted sync.";

export async function gistPlaintextAllowedWithoutAppSession(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const { isAppSessionExpired } = await import("../app-auth.js");
  if (isAppSessionExpired(context)) {
    return false;
  }
  if (context.globalState.get<string>("cursorSync.e2e.lastUserId")) {
    return false;
  }
  await hydrateKeysCacheFromDisk(context);
  const cache = getCachedKeysGate();
  return cache.presence !== "set";
}

export async function requireE2eUnlocked(
  context: vscode.ExtensionContext,
  options?: { gistSync?: boolean }
): Promise<E2eUnlockedResult> {
  const session = await getAppSession(context);
  if (!session) {
    if (options?.gistSync) {
      if (await gistPlaintextAllowedWithoutAppSession(context)) {
        return { ok: true, kind: "gist_plaintext" };
      }
      return { ok: false, message: APP_LOGIN_REQUIRED_MESSAGE };
    }
    return { ok: false, message: APP_LOGIN_REQUIRED_MESSAGE };
  }

  const snapshot = await refreshE2eGateContext(context);
  if (snapshot.phase === "keys_unavailable") {
    return {
      ok: false,
      message:
        snapshot.keysStatusMessage ??
        "Key service rate-limited. Retry in a few minutes from the sidebar.",
    };
  }
  if (snapshot.phase === "email_not_verified") {
    return {
      ok: false,
      message:
        "Verify your email on the Cursor Sync website, then use “I verified, re-check” in the sidebar.",
    };
  }
  if (snapshot.phase === "keys_not_set") {
    return {
      ok: false,
      message: "Create a sync passphrase to enable encrypted sync (Cursor Sync: Unlock).",
    };
  }
  if (snapshot.phase === "no_app_session") {
    return { ok: false, message: "Log in to Cursor Sync to use encrypted sync." };
  }
  if (snapshot.phase === "locked" || !snapshot.userId || !snapshot.keyVersion) {
    return { ok: false, message: E2E_LOCKED_SYNC_MESSAGE };
  }
  const dek = await loadStoredDek(context, snapshot.userId, snapshot.keyVersion);
  if (!dek) {
    invalidateE2eGateSnapshot();
    return { ok: false, message: E2E_LOCKED_SYNC_MESSAGE };
  }
  return {
    ok: true,
    kind: "dek",
    userId: snapshot.userId,
    keyVersion: snapshot.keyVersion,
    dek,
  };
}

export function onAppSessionCleared(context?: vscode.ExtensionContext): void {
  void invalidateKeysGateCache(context);
  invalidateE2eGateSnapshot();
}

export async function lockLocalDek(context: vscode.ExtensionContext): Promise<void> {
  const userId = context.globalState.get<string>("cursorSync.e2e.lastUserId");
  const versions = context.globalState.get<number[]>("cursorSync.e2e.dekVersions") ?? [];
  if (userId) {
    for (const version of versions) {
      await clearStoredDekForUser(context, userId, version);
    }
  }
  const snapshot = cachedSnapshot;
  if (snapshot?.userId && snapshot.keyVersion) {
    await clearStoredDekForUser(context, snapshot.userId, snapshot.keyVersion);
  }
  invalidateE2eGateSnapshot();
  await invalidateKeysGateCache(context);

  const session = await getAppSession(context);
  const claims = session ? parseAppSessionClaims(session) : undefined;
  const lockedUserId =
    claims?.userId ?? context.globalState.get<string>("cursorSync.e2e.lastUserId");
  const lockedKeyVersion = snapshot?.keyVersion ?? 1;
  if (lockedUserId) {
    cachedSnapshot = {
      phase: "locked",
      userId: lockedUserId,
      keyVersion: lockedKeyVersion,
    };
  } else {
    cachedSnapshot = { phase: "no_app_session" };
  }
  await applyE2eGateSnapshotToContext(cachedSnapshot);
}
