import * as vscode from "vscode";
import { hasAppSession } from "../app-configs.js";
import { loadSyncState, loadSyncHistory } from "../diagnostics.js";
import type { SyncTabState } from "./sync-tab.js";
import { renderSyncPane } from "./sync-tab.js";
import { renderSettingsPane, readSettingsValues } from "./settings-tab.js";

export async function buildSyncTabState(
  context: vscode.ExtensionContext
): Promise<SyncTabState> {
  const { isSyncOperationActive } = await import("../sync-operation.js");
  const syncState = await loadSyncState(context);
  const history = await loadSyncHistory(context);
  const appSessionActive = await hasAppSession(context);

  const base = {
    history,
    appSessionActive,
  };

  if (isSyncOperationActive()) {
    return {
      status: "syncing",
      lastSyncTime: syncState?.lastSyncTimestamp,
      lastSyncDirection: syncState?.lastSyncDirection,
      fileCount: syncState ? Object.keys(syncState.localChecksums).length : 0,
      gistId: syncState?.gistId,
      ...base,
    };
  }

  if (!syncState) {
    return {
      status: "not-synced",
      lastSyncTime: undefined,
      lastSyncDirection: undefined,
      fileCount: 0,
      gistId: undefined,
      ...base,
    };
  }

  return {
    status: "synced",
    lastSyncTime: syncState.lastSyncTimestamp,
    lastSyncDirection: syncState.lastSyncDirection,
    fileCount: Object.keys(syncState.localChecksums).length,
    gistId: syncState.gistId,
    ...base,
  };
}

export async function renderSyncPaneHtml(
  context: vscode.ExtensionContext
): Promise<string> {
  const state = await buildSyncTabState(context);
  return renderSyncPane(state);
}

export async function renderSidebarHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): Promise<string> {
  const state = await buildSyncTabState(context);
  const settingsValues = readSettingsValues();
  const syncPaneHtml = renderSyncPane(state);
  const settingsPaneHtml = renderSettingsPane(settingsValues);
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "resources", "sidebar", "webview.js")
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
      font-size: 13px;
      color: #edecec;
      background: #14120b;
      padding: 0;
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ── Tab Bar ── */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid rgba(237, 236, 236, 0.08);
      background: #0f0e0c;
      padding: 0 8px;
      gap: 2px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .tab-btn {
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      border: none;
      color: rgba(237, 236, 236, 0.4);
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s ease, border-color 0.15s ease;
      letter-spacing: 0.01em;
    }
    .tab-btn:hover {
      color: rgba(237, 236, 236, 0.7);
    }
    .tab-btn.active {
      color: #edecec;
      border-bottom-color: #34d399;
    }

    /* ── Tab Panes ── */
    .tab-pane {
      padding: 14px;
    }

    /* ── Status Card ── */
    .status-card {
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      border: 1px solid rgba(237, 236, 236, 0.06);
      background: #1c1a13;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .status-card:hover {
      border-color: rgba(237, 236, 236, 0.12);
    }
    .status-card.synced {
      background: linear-gradient(135deg, rgba(52, 211, 153, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(52, 211, 153, 0.15);
    }
    .status-card.synced:hover {
      border-color: rgba(52, 211, 153, 0.25);
      box-shadow: 0 0 20px rgba(52, 211, 153, 0.08);
    }
    .status-card.not-synced {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(245, 158, 11, 0.15);
    }
    .status-card.not-synced:hover {
      border-color: rgba(245, 158, 11, 0.25);
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.08);
    }
    .status-card.syncing {
      background: linear-gradient(135deg, rgba(125, 211, 252, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(125, 211, 252, 0.15);
    }
    .status-card.syncing:hover {
      border-color: rgba(125, 211, 252, 0.25);
      box-shadow: 0 0 20px rgba(125, 211, 252, 0.08);
    }
    .status-card.error {
      background: linear-gradient(135deg, rgba(248, 113, 113, 0.06) 0%, #1c1a13 100%);
      border-color: rgba(248, 113, 113, 0.15);
    }
    .status-card.error:hover {
      border-color: rgba(248, 113, 113, 0.25);
      box-shadow: 0 0 20px rgba(248, 113, 113, 0.08);
    }

    .status-icon-wrapper {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 18px;
      transition: box-shadow 0.2s ease;
      overflow: hidden;
    }
    .status-icon-wrapper svg {
      width: 28px;
      height: 28px;
    }
    .synced .status-icon-wrapper {
      background: rgba(52, 211, 153, 0.12);
      box-shadow: 0 0 12px rgba(52, 211, 153, 0.15);
    }
    .synced .status-icon-wrapper svg .st0 { fill: #34d399; }
    .synced .status-icon-wrapper svg .st1 { fill: #2cb885; }
    .synced .status-icon-wrapper svg .st3 { fill: #239b6f; }
    .synced .status-icon-wrapper svg .st4 { fill: #6ee7b7; }
    .synced .status-icon-wrapper svg .st2 { fill: transparent; }
    .not-synced .status-icon-wrapper {
      background: rgba(245, 158, 11, 0.12);
      color: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
    }
    .syncing .status-icon-wrapper {
      background: rgba(125, 211, 252, 0.12);
      color: #7dd3fc;
      box-shadow: 0 0 12px rgba(125, 211, 252, 0.15);
    }
    .error .status-icon-wrapper {
      background: rgba(248, 113, 113, 0.12);
      color: #f87171;
      box-shadow: 0 0 12px rgba(248, 113, 113, 0.15);
    }

    .status-info { flex: 1; min-width: 0; }
    .status-label {
      font-weight: 600;
      font-size: 14px;
      display: block;
      margin-bottom: 3px;
      letter-spacing: -0.01em;
    }
    .status-meta {
      font-size: 11px;
      color: rgba(237, 236, 236, 0.32);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .status-meta .codicon { font-size: 11px; color: rgba(237, 236, 236, 0.22); }

    .file-count {
      font-size: 11px;
      color: rgba(237, 236, 236, 0.22);
      margin-top: 3px;
    }

    /* ── Sync Now Button ── */
    .sync-now-btn {
      width: 100%;
      padding: 10px 16px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: #ededec;
      color: #0c0c0a;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      letter-spacing: -0.01em;
      transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .sync-now-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(237, 236, 236, 0.1);
      background: rgba(237, 236, 236, 0.88);
    }
    .sync-now-btn:active {
      transform: translateY(0);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
      filter: brightness(0.95);
    }

    /* ── Section Headers ── */
    .section { margin-bottom: 16px; }
    .section-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: rgba(237, 236, 236, 0.32);
      margin-bottom: 8px;
      padding: 0 2px;
    }

    /* ── Action Grid ── */
    .action-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .action-btn {
      padding: 9px 12px;
      border: 1px solid rgba(237, 236, 236, 0.06);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: #1c1a13;
      color: rgba(237, 236, 236, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .action-btn:hover {
      background: #22201a;
      border-color: rgba(237, 236, 236, 0.12);
      color: #edecec;
    }
    .action-btn:active {
      background: #1a1812;
      transform: scale(0.98);
    }
    .action-btn .codicon {
      color: #34d399;
      font-size: 13px;
      transition: color 0.15s ease;
    }
    .action-btn:hover .codicon {
      color: #6ee7b7;
    }

    /* ── History List ── */
    .history-list { display: flex; flex-direction: column; gap: 2px; }
    .history-entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      gap: 8px;
      background: #0f0e0c;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .history-entry:hover {
      background: #22201a;
      border-color: rgba(237, 236, 236, 0.06);
    }
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
    .history-dir { font-weight: 500; color: rgba(237, 236, 236, 0.55); }
    .history-detail { color: rgba(237, 236, 236, 0.32); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .history-time { color: rgba(237, 236, 236, 0.22); font-size: 11px; white-space: nowrap; }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.success {
      background: #34d399;
      box-shadow: 0 0 6px rgba(52, 211, 153, 0.4);
    }
    .status-dot.failure {
      background: #f87171;
      box-shadow: 0 0 6px rgba(248, 113, 113, 0.4);
    }

    .badge {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .badge-auto {
      background: rgba(237, 236, 236, 0.05);
      color: rgba(237, 236, 236, 0.32);
      border: 1px solid rgba(237, 236, 236, 0.12);
    }

    .empty-state {
      text-align: center;
      padding: 20px 8px;
      color: rgba(237, 236, 236, 0.22);
      font-size: 12px;
      font-style: italic;
    }

    /* ── Configure GitHub Button ── */
    .configure-btn {
      width: 100%;
      padding: 9px 12px;
      border: 1px dashed rgba(237, 236, 236, 0.08);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      background: transparent;
      color: rgba(237, 236, 236, 0.32);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .configure-btn:hover {
      border-color: rgba(52, 211, 153, 0.3);
      color: #34d399;
      background: rgba(52, 211, 153, 0.04);
    }
    .configure-btn .codicon { font-size: 13px; }

    .codicon {
      font-family: 'codicon';
      font-size: 14px;
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #161614; }
    ::-webkit-scrollbar-thumb { background: #2a2a28; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #3a3a37; }

    /* ── Chats Tab ── */
    .chats-section { margin-bottom: 16px; }
    .chats-section-header {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: rgba(237, 236, 236, 0.32);
      margin-bottom: 8px;
      padding: 0 2px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .chats-list { display: flex; flex-direction: column; gap: 2px; }
    .chat-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      gap: 8px;
      background: #0f0e0c;
      border: 1px solid transparent;
      transition: all 0.15s ease;
    }
    .chat-row:hover {
      background: #22201a;
      border-color: rgba(237, 236, 236, 0.06);
    }
    .chat-row-info { flex: 1; min-width: 0; }
    .chat-row-title {
      font-weight: 500;
      color: rgba(237, 236, 236, 0.8);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .chat-row-meta {
      font-size: 11px;
      color: rgba(237, 236, 236, 0.3);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .chat-row-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .chat-action-btn {
      padding: 3px 6px;
      border: 1px solid rgba(237, 236, 236, 0.06);
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
      background: transparent;
      color: rgba(237, 236, 236, 0.4);
      transition: all 0.15s ease;
    }
    .chat-action-btn:hover {
      border-color: rgba(52, 211, 153, 0.3);
      color: #34d399;
      background: rgba(52, 211, 153, 0.04);
    }
    .progress-card {
      padding: 10px 12px;
      border-radius: 8px;
      background: #1c1a13;
      border: 1px solid rgba(125, 211, 252, 0.15);
      font-size: 12px;
    }
    .progress-phase {
      font-weight: 600;
      color: #7dd3fc;
      margin-bottom: 4px;
    }
    .progress-message {
      color: rgba(237, 236, 236, 0.6);
    }
    .progress-bar-track {
      height: 3px;
      background: rgba(237, 236, 236, 0.1);
      border-radius: 2px;
      margin-top: 8px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: #7dd3fc;
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .clear-btn {
      padding: 2px 8px;
      border: 1px solid rgba(237, 236, 236, 0.08);
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
      background: transparent;
      color: rgba(237, 236, 236, 0.32);
      transition: all 0.15s ease;
    }
    .clear-btn:hover {
      border-color: rgba(248, 113, 113, 0.3);
      color: #f87171;
    }

    /* ── Settings Tab ── */
    .settings-list { display: flex; flex-direction: column; gap: 8px; }
    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 4px;
    }
    .settings-label {
      font-size: 12px;
      color: rgba(237, 236, 236, 0.7);
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      flex: 1;
    }
    .settings-input {
      width: 64px;
      padding: 4px 8px;
      border: 1px solid rgba(237, 236, 236, 0.1);
      border-radius: 4px;
      background: #1c1a13;
      color: #edecec;
      font-size: 12px;
      text-align: right;
    }
    .settings-input-text {
      width: 120px;
      text-align: left;
    }
    .settings-input:focus {
      outline: none;
      border-color: rgba(52, 211, 153, 0.4);
    }
    input[type="checkbox"] {
      accent-color: #34d399;
      width: 14px;
      height: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="sync-pane">Sync</button>
    <button class="tab-btn" data-tab="chats-pane">Chats</button>
    <button class="tab-btn" data-tab="settings-pane">Settings</button>
  </div>

  ${syncPaneHtml}

  <div id="chats-pane" class="tab-pane" style="display:none">
    <div class="chats-section" id="chats-active-section" style="display:none">
      <div class="chats-section-header">Active Operation</div>
      <div id="chats-active"></div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">
        <span>Recent in this workspace</span>
      </div>
      <div id="chats-recent" class="chats-list">
        <div class="empty-state">Loading\u2026</div>
      </div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">
        <span>Imports &amp; bundles</span>
        <button class="clear-btn" data-command="chats:clearHistory">Clear</button>
      </div>
      <div id="chats-imports" class="chats-list">
        <div class="empty-state">Loading\u2026</div>
      </div>
    </div>

    <div class="chats-section">
      <div class="chats-section-header">Bundle files</div>
      <div id="chats-bundles" class="chats-list">
        <div class="empty-state">Loading\u2026</div>
      </div>
    </div>
  </div>

  ${settingsPaneHtml}

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
