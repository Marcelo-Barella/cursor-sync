import * as vscode from "vscode";

let statusBarItem: vscode.StatusBarItem;

export type SyncState = "ok" | "syncing" | "error" | "conflict" | "unconfigured";

export type StatusBarDestination = "github-gist" | "cursor-sync-storage";

export interface StatusBarUpdateOptions {
  lastSync?: Date;
  destination?: StatusBarDestination;
  detail?: string;
  /** Command when state is unconfigured (defaults to GitHub setup). */
  unconfiguredCommand?: string;
}

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

export function updateStatusBar(
  state: SyncState,
  options?: StatusBarUpdateOptions
): void {
  if (!statusBarItem) {
    return;
  }

  const lastSync = options?.lastSync;
  const destination = options?.destination;
  const detail = options?.detail;

  let icon = "";
  let text = "Cursor Sync";
  let tooltip = "Cursor Sync Status";

  switch (state) {
    case "ok":
      icon = "$(check)";
      if (destination === "cursor-sync-storage") {
        text = "Sync: Storage";
        tooltip = detail
          ? `Cursor Sync storage — ${detail}`
          : lastSync
            ? `Cursor Sync storage — last sync ${lastSync.toLocaleString()}`
            : "Logged in to Cursor Sync storage";
      } else {
        text = "Sync: OK";
        tooltip = lastSync
          ? `Last synced: ${lastSync.toLocaleString()}`
          : "Synced successfully";
      }
      break;
    case "syncing":
      icon = "$(sync~spin)";
      text =
        destination === "cursor-sync-storage" ? "Syncing storage..." : "Syncing...";
      tooltip =
        destination === "cursor-sync-storage"
          ? "Synchronizing with Cursor Sync storage..."
          : "Synchronizing with GitHub...";
      break;
    case "error":
      icon = "$(error)";
      text =
        destination === "cursor-sync-storage" ? "Storage: Error" : "Sync: Error";
      tooltip = detail ?? "Error during synchronization. Click to view logs.";
      break;
    case "conflict":
      icon = "$(warning)";
      text =
        destination === "cursor-sync-storage" ? "Storage: Conflict" : "Sync: Conflict";
      tooltip = detail ?? "Storage sync conflict. Resolve manually.";
      break;
    case "unconfigured":
      icon = "$(gear)";
      text = "Sync: Setup";
      tooltip = "Cursor Sync is not configured. Click to set up.";
      statusBarItem.command =
        options?.unconfiguredCommand ?? "cursorSync.configureGithub";
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
