import type * as vscode from "vscode";
import { getToken } from "./auth.js";
import { hasAppSession } from "./app-configs.js";
import { formatStatusTimestamp, loadSyncHistory, loadSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { isSyncOperationActive } from "./sync-operation.js";

function latestStorageHistoryEntry(
  history: Awaited<ReturnType<typeof loadSyncHistory>>
) {
  return history.find((entry) => entry.destination === "cursor-sync-storage");
}

function storageStatusDetail(
  entry: NonNullable<ReturnType<typeof latestStorageHistoryEntry>>
): string {
  const when = formatStatusTimestamp(entry.timestamp);
  if (entry.success) {
    return `${entry.direction} succeeded at ${when} (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})`;
  }
  return `${entry.direction} failed at ${when}${entry.error ? `: ${entry.error}` : ""}`;
}

export async function refreshSyncStatusBar(
  context: vscode.ExtensionContext,
  options?: { failed?: boolean }
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
    const latest = latestStorageHistoryEntry(history);
    if (options?.failed || (latest && !latest.success)) {
      updateStatusBar("error", {
        destination: "cursor-sync-storage",
        detail: latest ? storageStatusDetail(latest) : "Sync failed",
        lastSync: latest ? new Date(latest.timestamp) : undefined,
      });
      return;
    }
    updateStatusBar("ok", {
      destination: "cursor-sync-storage",
      lastSync: latest ? new Date(latest.timestamp) : undefined,
      detail: latest
        ? storageStatusDetail(latest)
        : "Logged in — no storage sync yet",
    });
    return;
  }

  if (options?.failed) {
    updateStatusBar("error", { lastSync: new Date(), destination: "github-gist" });
    return;
  }

  const token = await getToken(context);
  if (!token) {
    updateStatusBar("unconfigured");
    return;
  }

  const syncState = await loadSyncState(context);
  updateStatusBar("ok", {
    destination: "github-gist",
    lastSync: syncState ? new Date(syncState.lastSyncTimestamp) : undefined,
  });
}
