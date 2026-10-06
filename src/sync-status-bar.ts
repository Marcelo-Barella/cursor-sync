import type * as vscode from "vscode";
import { getToken } from "./auth.js";
import { hasAppSession } from "./app-configs.js";
import { loadSyncHistory } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { isSyncOperationActive } from "./sync-operation.js";
import {
  activeScheduledRootHeldFingerprint,
  deriveStorageSyncPresentation,
} from "./storage-sync-ui-status.js";

export async function refreshSyncStatusBar(
  context: vscode.ExtensionContext,
  options?: { failed?: boolean; held?: boolean; warning?: boolean }
): Promise<void> {
  const appSessionActive = await hasAppSession(context);

  if (isSyncOperationActive()) {
    updateStatusBar("syncing", {
      destination: appSessionActive ? "cursor-sync-storage" : "github-gist",
    });
    return;
  }

  if (appSessionActive) {
    let history: Awaited<ReturnType<typeof loadSyncHistory>> = [];
    try {
      history = await loadSyncHistory(context);
    } catch {
      history = [];
    }
    const heldFp = activeScheduledRootHeldFingerprint(context);
    const tickFailed = options?.failed === true;
    const presentation = deriveStorageSyncPresentation({
      history,
      activeHeldFingerprint: heldFp,
      tickFailed,
    });
    if (options?.held && presentation.level === "ok") {
      presentation.level = "warning";
      presentation.warningKind = "held";
      presentation.detail = "Sync held";
    }
    if (options?.warning && presentation.level === "ok") {
      presentation.level = "warning";
      presentation.warningKind = presentation.warningKind ?? "partial";
    }
    switch (presentation.level) {
      case "error":
        updateStatusBar("error", {
          destination: "cursor-sync-storage",
          detail: presentation.detail,
          lastSync: presentation.lastSync,
        });
        return;
      case "conflict":
        updateStatusBar("conflict", {
          destination: "cursor-sync-storage",
          detail: presentation.detail,
          lastSync: presentation.lastSync,
        });
        return;
      case "warning":
        updateStatusBar("warning", {
          destination: "cursor-sync-storage",
          detail: presentation.detail,
          lastSync: presentation.lastSync,
        });
        return;
      default:
        updateStatusBar("ok", {
          destination: "cursor-sync-storage",
          lastSync: presentation.lastSync,
          detail: presentation.detail,
        });
        return;
    }
  }

  if (options?.failed) {
    updateStatusBar("error", { lastSync: new Date(), destination: "github-gist" });
    return;
  }

  const { loadSyncState } = await import("./diagnostics.js");
  const syncState = await loadSyncState(context);
  const token = await getToken(context);
  if (!token) {
    updateStatusBar("unconfigured", {
      unconfiguredCommand: syncState?.gistId
        ? "cursorSync.configureGithub"
        : "cursorSync.loginToApp",
    });
    return;
  }
  updateStatusBar("ok", {
    lastSync: syncState?.lastSyncTimestamp
      ? new Date(syncState.lastSyncTimestamp)
      : undefined,
    destination: "github-gist",
  });
}
