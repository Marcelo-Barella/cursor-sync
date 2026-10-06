import * as vscode from "vscode";
import { clearAppSession, clearPersistedAuthHandoff } from "./app-auth.js";
import { clearToken } from "./auth.js";
import { clearAllStoredDeks } from "./e2e/dek-storage.js";
import { onAppSessionCleared, refreshE2eGateAfterCryptoChange } from "./e2e/gate.js";
import { clearMigrationState } from "./e2e/migration.js";
import { clearSyncState } from "./diagnostics.js";
import { refreshSidebar } from "./sidebar/index.js";
import { refreshSyncStatusBar } from "./sync-status-bar.js";
import { resetSyncOperation } from "./sync-operation.js";

export async function executeReset(context: vscode.ExtensionContext): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    "Are you sure you want to reset Cursor Sync? This will remove your GitHub token, sync state, and reset extension settings to their defaults.",
    { modal: true },
    "Reset"
  );

  if (confirmation !== "Reset") {
    return;
  }

  resetSyncOperation();

  await clearToken(context);
  await clearAllStoredDeks(context);
  await clearMigrationState(context);
  onAppSessionCleared(context);
  await clearAppSession(context);
  await clearPersistedAuthHandoff(context);

  await clearSyncState(context);

  // Reset Configuration Settings
  const config = vscode.workspace.getConfiguration("cursorSync");
  const keys = [
    "enabledPaths",
    "excludeGlobs",
    "schedule.enabled",
    "schedule.intervalMin",
    "maxFileSizeKB",
    "syncProfileName",
    "safeMode"
  ];

  for (const key of keys) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }

  // Update UI Context
  await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
  await refreshE2eGateAfterCryptoChange(context);
  await refreshSyncStatusBar(context);
  refreshSidebar();

  vscode.window.showInformationMessage("Cursor Sync has been fully reset.");
}
