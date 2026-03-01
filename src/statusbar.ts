import * as vscode from "vscode";

let statusBarItem: vscode.StatusBarItem;

export type SyncState = "ok" | "syncing" | "error" | "unconfigured";

export function initializeStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursorSync.showStatus";
  context.subscriptions.push(statusBarItem);
  
  updateStatusBar("unconfigured");
  statusBarItem.show();
}

export function updateStatusBar(state: SyncState, lastSync?: Date): void {
  if (!statusBarItem) {
    return;
  }

  let icon = "";
  let text = "Cursor Sync";
  let tooltip = "Cursor Sync Status";

  switch (state) {
    case "ok":
      icon = "$(check)";
      text = "Sync: OK";
      tooltip = lastSync ? `Last synced: ${lastSync.toLocaleString()}` : "Synced successfully";
      break;
    case "syncing":
      icon = "$(sync~spin)";
      text = "Syncing...";
      tooltip = "Synchronizing with GitHub...";
      break;
    case "error":
      icon = "$(error)";
      text = "Sync: Error";
      tooltip = "Error during synchronization. Click to view logs.";
      break;
    case "unconfigured":
      icon = "$(gear)";
      text = "Sync: Setup";
      tooltip = "Cursor Sync is not configured. Click to set up.";
      // Change command to configure if unconfigured
      statusBarItem.command = "cursorSync.configureGithub";
      break;
  }

  if (state !== "unconfigured") {
    statusBarItem.command = "cursorSync.showStatus";
  }

  statusBarItem.text = `${icon} ${text}`;
  statusBarItem.tooltip = tooltip;
}

export function showStatusBar(): void {
  statusBarItem?.show();
}

export function hideStatusBar(): void {
  statusBarItem?.hide();
}
