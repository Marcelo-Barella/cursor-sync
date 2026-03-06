import * as vscode from "vscode";
import { loadSyncState, loadSyncHistory } from "./diagnostics.js";
import type { SyncHistoryEntry } from "./types.js";

let sidebarProviderInstance: SidebarProvider | undefined;

export function initializeSidebar(context: vscode.ExtensionContext): SidebarProvider {
  sidebarProviderInstance = new SidebarProvider(context);
  return sidebarProviderInstance;
}

export function refreshSidebar(): void {
  sidebarProviderInstance?.refresh();
}

interface SidebarState {
  status: "synced" | "not-synced" | "syncing" | "error";
  lastSyncTime: string | undefined;
  lastSyncDirection: "push" | "pull" | undefined;
  fileCount: number;
  gistId: string | undefined;
  history: SyncHistoryEntry[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case "syncNow":
          vscode.commands.executeCommand("cursorSync.syncNow");
          break;
        case "push":
          vscode.commands.executeCommand("cursorSync.push");
          break;
        case "pull":
          vscode.commands.executeCommand("cursorSync.pull");
          break;
        case "export":
          vscode.commands.executeCommand("cursorSync.export");
          break;
        case "import":
          vscode.commands.executeCommand("cursorSync.import");
          break;
        case "configure":
          vscode.commands.executeCommand("cursorSync.configureGithub");
          break;
      }
    });

    this._updateView();
  }

  refresh(): void {
    this._updateView();
  }

  private async _updateView(): Promise<void> {
    if (!this._view) {
      return;
    }
    const state = await this._getState();
    this._view.webview.html = getWebviewHtml(state);
  }

  private async _getState(): Promise<SidebarState> {
    const syncState = await loadSyncState(this.context);
    const history = await loadSyncHistory(this.context);

    if (!syncState) {
      return {
        status: "not-synced",
        lastSyncTime: undefined,
        lastSyncDirection: undefined,
        fileCount: 0,
        gistId: undefined,
        history,
      };
    }

    return {
      status: "synced",
      lastSyncTime: syncState.lastSyncTimestamp,
      lastSyncDirection: syncState.lastSyncDirection,
      fileCount: Object.keys(syncState.localChecksums).length,
      gistId: syncState.gistId,
      history,
    };
  }
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }

  return new Date(isoString).toLocaleDateString();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderHistoryEntry(entry: SyncHistoryEntry): string {
  const icon = entry.direction === "push" ? "arrow-up" : "arrow-down";
  const dirLabel = entry.direction === "push" ? "Push" : "Pull";
  const triggerBadge = entry.trigger === "scheduled" ? `<span class="badge badge-auto">auto</span>` : "";
  const statusClass = entry.success ? "success" : "failure";
  const statusDot = `<span class="status-dot ${statusClass}"></span>`;
  const time = relativeTime(entry.timestamp);
  const detail = entry.success
    ? `${entry.fileCount} file${entry.fileCount !== 1 ? "s" : ""}`
    : escapeHtml(entry.error ?? "Failed");

  return `<div class="history-entry">
    <div class="history-entry-left">
      ${statusDot}
      <span class="codicon codicon-${icon}"></span>
      <span class="history-dir">${dirLabel}</span>
      ${triggerBadge}
    </div>
    <div class="history-entry-right">
      <span class="history-detail">${detail}</span>
      <span class="history-time">${time}</span>
    </div>
  </div>`;
}

function getWebviewHtml(state: SidebarState): string {
  const statusIconMap = {
    synced: "check",
    "not-synced": "warning",
    syncing: "sync~spin",
    error: "error",
  };
  const statusLabelMap = {
    synced: "Synced",
    "not-synced": "Not Synced",
    syncing: "Syncing...",
    error: "Sync Error",
  };

  const statusIcon = statusIconMap[state.status];
  const statusLabel = statusLabelMap[state.status];
  const lastSyncText = state.lastSyncTime ? relativeTime(state.lastSyncTime) : "Never";
  const directionIcon = state.lastSyncDirection === "push" ? "arrow-up" : state.lastSyncDirection === "pull" ? "arrow-down" : "";
  const directionLabel = state.lastSyncDirection === "push" ? "Push" : state.lastSyncDirection === "pull" ? "Pull" : "";

  const historyHtml = state.history.length > 0
    ? state.history.map(renderHistoryEntry).join("")
    : `<div class="empty-state">No sync history yet</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      line-height: 1.4;
    }

    .status-card {
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    .status-card.synced {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 30%, transparent);
    }
    .status-card.not-synced {
      background: color-mix(in srgb, var(--vscode-problemsWarningIcon-foreground) 12%, transparent);
      border-color: color-mix(in srgb, var(--vscode-problemsWarningIcon-foreground) 30%, transparent);
    }
    .status-card.syncing {
      background: color-mix(in srgb, var(--vscode-progressBar-background) 12%, transparent);
      border-color: color-mix(in srgb, var(--vscode-progressBar-background) 30%, transparent);
    }
    .status-card.error {
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 12%, transparent);
      border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 30%, transparent);
    }

    .status-icon-wrapper {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 18px;
    }
    .synced .status-icon-wrapper { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 25%, transparent); color: var(--vscode-testing-iconPassed); }
    .not-synced .status-icon-wrapper { background: color-mix(in srgb, var(--vscode-problemsWarningIcon-foreground) 25%, transparent); color: var(--vscode-problemsWarningIcon-foreground); }
    .syncing .status-icon-wrapper { background: color-mix(in srgb, var(--vscode-progressBar-background) 25%, transparent); color: var(--vscode-progressBar-background); }
    .error .status-icon-wrapper { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 25%, transparent); color: var(--vscode-testing-iconFailed); }

    .status-info { flex: 1; min-width: 0; }
    .status-label { font-weight: 600; display: block; margin-bottom: 2px; }
    .status-meta {
      font-size: 11px;
      opacity: 0.75;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .status-meta .codicon { font-size: 11px; }

    .sync-now-btn {
      width: 100%;
      padding: 8px 14px;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .sync-now-btn:hover { background: var(--vscode-button-hoverBackground); }
    .sync-now-btn:active { opacity: 0.85; }

    .section { margin-bottom: 14px; }
    .section-header {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.65;
      margin-bottom: 6px;
      padding: 0 2px;
    }

    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .action-btn {
      padding: 7px 10px;
      border: 1px solid var(--vscode-widget-border, color-mix(in srgb, var(--vscode-foreground) 15%, transparent));
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.1s;
    }
    .action-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .history-list { display: flex; flex-direction: column; gap: 2px; }
    .history-entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 4px;
      font-size: 12px;
      gap: 8px;
    }
    .history-entry:hover { background: var(--vscode-list-hoverBackground); }
    .history-entry-left {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .history-entry-right {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 1;
    }
    .history-dir { font-weight: 500; }
    .history-detail { opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-time { opacity: 0.5; font-size: 11px; white-space: nowrap; }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.success { background: var(--vscode-testing-iconPassed); }
    .status-dot.failure { background: var(--vscode-testing-iconFailed); }

    .badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 500;
    }
    .badge-auto {
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      opacity: 0.7;
    }

    .empty-state {
      text-align: center;
      padding: 16px 8px;
      opacity: 0.5;
      font-size: 12px;
    }

    .file-count {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 2px;
    }

    .codicon {
      font-family: 'codicon';
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="status-card ${state.status}">
    <div class="status-icon-wrapper">
      <span class="codicon codicon-${statusIcon}"></span>
    </div>
    <div class="status-info">
      <span class="status-label">${statusLabel}</span>
      <div class="status-meta">
        <span>${lastSyncText}</span>
        ${directionLabel ? `<span class="codicon codicon-${directionIcon}"></span><span>${directionLabel}</span>` : ""}
      </div>
      ${state.fileCount > 0 ? `<div class="file-count">${state.fileCount} file${state.fileCount !== 1 ? "s" : ""} tracked</div>` : ""}
    </div>
  </div>

  <button class="sync-now-btn" onclick="post('syncNow')">
    <span class="codicon codicon-sync"></span>
    Sync Now
  </button>

  <div class="section">
    <div class="section-header">Actions</div>
    <div class="action-grid">
      <button class="action-btn" onclick="post('push')"><span class="codicon codicon-cloud-upload"></span> Push</button>
      <button class="action-btn" onclick="post('pull')"><span class="codicon codicon-cloud-download"></span> Pull</button>
      <button class="action-btn" onclick="post('export')"><span class="codicon codicon-export"></span> Export</button>
      <button class="action-btn" onclick="post('import')"><span class="codicon codicon-desktop-download"></span> Import</button>
    </div>
  </div>

  <div class="section">
    <div class="section-header">History</div>
    <div class="history-list">
      ${historyHtml}
    </div>
  </div>

  <div class="section">
    <button class="action-btn" style="width:100%" onclick="post('configure')">
      <span class="codicon codicon-github-alt"></span> Configure GitHub
    </button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function post(command) { vscode.postMessage({ command }); }
  </script>
</body>
</html>`;
}
