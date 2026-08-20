import type { SyncHistoryEntry } from "../types.js";

export interface SyncTabState {
  status: "synced" | "not-synced" | "syncing" | "error";
  lastSyncTime: string | undefined;
  lastSyncDirection: "push" | "pull" | undefined;
  fileCount: number;
  gistId: string | undefined;
  history: SyncHistoryEntry[];
}

export function relativeTime(isoString: string): string {
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

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHistoryEntry(entry: SyncHistoryEntry): string {
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

export function renderSyncPane(state: SyncTabState): string {
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

  const cursorLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 746.78 746.78">
    <rect fill="transparent" width="746.78" height="746.78"/>
    <g>
      <path class="st0" d="M373.39,373.39l239.25,138.13c-1.47,2.55-3.6,4.72-6.24,6.24l-223.63,129.11c-5.81,3.35-12.97,3.35-18.78,0l-223.63-129.11c-2.64-1.52-4.77-3.7-6.24-6.24l239.25-138.13h.02Z"/>
      <path class="st1" d="M373.39,97.39v276l-239.25,138.13c-1.47-2.55-2.29-5.49-2.29-8.53V243.79c0-6.1,3.25-11.72,8.53-14.77l223.62-129.11c2.91-1.68,6.15-2.52,9.39-2.52h.01s-.01,0-.01,0Z"/>
      <path class="st3" d="M612.64,235.26c-1.47-2.55-3.6-4.72-6.24-6.24l-223.63-129.11c-2.9-1.68-6.14-2.52-9.38-2.52v276l239.25,138.13c1.47-2.55,2.29-5.49,2.29-8.53V243.79c0-3.05-.81-5.97-2.29-8.53h-.01.01Z"/>
      <path class="st4" d="M595.9,244.93c1.36,2.34,1.54,5.34,0,8.01l-217.18,376.15c-1.46,2.55-5.34,1.5-5.34-1.43v-247.87c0-1.98-.53-3.88-1.49-5.55l224-129.33h.01v.02Z"/>
      <path class="st2" d="M595.9,244.93l-224,129.33c-.95-1.66-2.34-3.06-4.06-4.06l-214.65-123.93c-2.55-1.46-1.5-5.34,1.43-5.34h434.34c3.08,0,5.59,1.67,6.93,4.01h.01Z"/>
    </g>
  </svg>`;

  const historyHtml = state.history.length > 0
    ? state.history.map(renderHistoryEntry).join("")
    : `<div class="empty-state">No sync history yet</div>`;

  return `<div id="sync-pane" class="tab-pane">
  <div class="status-card ${state.status}">
    <div class="status-icon-wrapper">
      ${state.status === "synced" ? cursorLogoSvg : `<span class="codicon codicon-${statusIcon}"></span>`}
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

  <button class="sync-now-btn" data-command="syncNow">
    <span class="codicon codicon-sync"></span>
    Sync Now
  </button>

  <div class="section">
    <div class="section-header">Actions</div>
    <div class="action-grid">
      <button class="action-btn" data-command="push"><span class="codicon codicon-cloud-upload"></span> Push</button>
      <button class="action-btn" data-command="pull"><span class="codicon codicon-cloud-download"></span> Pull</button>
      <button class="action-btn" data-command="export"><span class="codicon codicon-export"></span> Export</button>
      <button class="action-btn" data-command="import"><span class="codicon codicon-desktop-download"></span> Import</button>
    </div>
  </div>

  <div class="section">
    <div class="section-header">History</div>
    <div class="history-list">
      ${historyHtml}
    </div>
  </div>

  <div class="section">
    <div class="section-header">Account</div>
    <button class="configure-btn" data-command="loginToApp">
      <span class="codicon codicon-sign-in"></span> Log in to Cursor Sync
    </button>
    <button class="configure-btn" data-command="enterAppAuthCode" style="margin-top:8px">
      <span class="codicon codicon-key"></span> Enter Login Code
    </button>
    <button class="configure-btn" data-command="configure" style="margin-top:8px">
      <span class="codicon codicon-github-alt"></span> Configure GitHub
    </button>
  </div>
</div>`;
}
