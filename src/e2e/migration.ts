import * as vscode from "vscode";
import { E2E_MIGRATION_STATE_KEY } from "./constants.js";

export interface E2eMigrationState {
  phase: "pending" | "in_progress" | "completed";
  completedPlaintextR2Keys: string[];
  completedPlaintextGistFiles: string[];
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
  });
}

export async function clearMigrationState(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(E2E_MIGRATION_STATE_KEY, undefined);
}
