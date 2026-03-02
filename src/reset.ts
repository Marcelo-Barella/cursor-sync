import * as vscode from "vscode";
import { clearToken } from "./auth.js";
import { clearSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar.js";

export async function executeReset(context: vscode.ExtensionContext): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    "Are you sure you want to reset Cursor Sync? This will remove your GitHub token, sync state, and reset extension settings to their defaults.",
    { modal: true },
    "Reset"
  );

  if (confirmation !== "Reset") {
    return;
  }

  // Clear GitHub Token
  await clearToken(context);

  // Clear Sync State (Gist ID, timestamps, checksums)
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
  updateStatusBar("unconfigured");
  refreshSidebar();

  vscode.window.showInformationMessage("Cursor Sync has been fully reset.");
}
