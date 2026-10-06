import * as vscode from "vscode";
import { E2E_MIGRATION_STATE_KEY } from "./constants.js";

export interface E2eMigrationState {
  phase: "pending" | "in_progress" | "completed";
  completedPlaintextR2Keys: string[];
  completedPlaintextGistFiles: string[];
  legacyPayloadCleared?: boolean;
}

export async function loadMigrationState(
  context: vscode.ExtensionContext
): Promise<E2eMigrationState | undefined> {
  return context.globalState.get<E2eMigrationState>(E2E_MIGRATION_STATE_KEY);
}

export async function saveMigrationState(
  context: vscode.ExtensionContext,
  state: E2eMigrationState
): Promise<void> {
  await context.globalState.update(E2E_MIGRATION_STATE_KEY, state);
}

export async function markMigrationPending(context: vscode.ExtensionContext): Promise<void> {
  const existing = await loadMigrationState(context);
  if (existing?.phase === "completed") {
    return;
  }
  await saveMigrationState(context, {
    phase: "pending",
    completedPlaintextR2Keys: existing?.completedPlaintextR2Keys ?? [],
    completedPlaintextGistFiles: existing?.completedPlaintextGistFiles ?? [],
    legacyPayloadCleared: existing?.legacyPayloadCleared,
  });
}

export async function clearMigrationState(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(E2E_MIGRATION_STATE_KEY, undefined);
}

export async function markMigrationCompleted(
  context: vscode.ExtensionContext
): Promise<void> {
  const existing = await loadMigrationState(context);
  await saveMigrationState(context, {
    phase: "completed",
    completedPlaintextR2Keys: existing?.completedPlaintextR2Keys ?? [],
    completedPlaintextGistFiles: existing?.completedPlaintextGistFiles ?? [],
    legacyPayloadCleared: true,
  });
}

export async function tryCompleteMigration(
  context: vscode.ExtensionContext,
  source: "gist" | "app"
): Promise<void> {
  const state = await loadMigrationState(context);
  if (!state || state.phase === "completed") {
    return;
  }

  const { getAppSession } = await import("../app-auth.js");
  const { loadSyncState } = await import("../diagnostics.js");
  const { listRemoteLegacyPlaintextKeys } = await import("./legacy-cleanup.js");

  const hasApp = !!(await getAppSession(context));
  const syncState = await loadSyncState(context);
  const hasGist = Boolean(syncState?.gistId);

  if (hasApp) {
    const legacyKeys = await listRemoteLegacyPlaintextKeys(context);
    const pendingLegacy = legacyKeys.filter(
      (k) => !state.completedPlaintextR2Keys.includes(k)
    );
    if (legacyKeys.length > 0 && pendingLegacy.length > 0) {
      return;
    }
    if (!state.legacyPayloadCleared && legacyKeys.length > 0) {
      return;
    }
  }

  if (source === "gist") {
    if (!hasApp) {
      return;
    }
    if (hasGist && state.completedPlaintextGistFiles.length === 0) {
      return;
    }
    await markMigrationCompleted(context);
    return;
  }

  if (!hasGist) {
    await markMigrationCompleted(context);
    return;
  }
  if (state.completedPlaintextGistFiles.length > 0) {
    await markMigrationCompleted(context);
  }
}
