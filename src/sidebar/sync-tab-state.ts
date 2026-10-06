import type { SyncHistoryEntry } from "../types.js";
import type { SyncTabState } from "./sync-tab.js";

function latestAttemptForDestination(
  history: SyncHistoryEntry[],
  destination: "github-gist" | "cursor-sync-storage"
): SyncHistoryEntry | undefined {
  return history.find(
    (entry) => (entry.destination ?? "github-gist") === destination
  );
}

export function buildSyncTabStateFromInputs(input: {
  history: SyncHistoryEntry[];
  appSessionActive: boolean;
  syncState?: {
    lastSyncTimestamp: string;
    lastSyncDirection: "push" | "pull";
    localChecksums: Record<string, string>;
    gistId: string;
  };
  isSyncOperationActive: boolean;
}): SyncTabState {
  const { history, appSessionActive, syncState, isSyncOperationActive } = input;
  const storageAttempt = latestAttemptForDestination(history, "cursor-sync-storage");
  const gistAttempt = latestAttemptForDestination(history, "github-gist");

  const base = {
    history,
    appSessionActive,
  };

  if (isSyncOperationActive) {
    const active = appSessionActive && storageAttempt ? storageAttempt : undefined;
    return {
      status: "syncing",
      lastSyncTime: active?.timestamp ?? syncState?.lastSyncTimestamp,
      lastSyncDirection: active?.direction ?? syncState?.lastSyncDirection,
      fileCount: syncState ? Object.keys(syncState.localChecksums).length : storageAttempt?.fileCount ?? 0,
      gistId: syncState?.gistId,
      statusDetail: undefined,
      ...base,
    };
  }

  if (appSessionActive && storageAttempt) {
    return {
      status: storageAttempt.success ? "synced" : "error",
      lastSyncTime: storageAttempt.timestamp,
      lastSyncDirection: storageAttempt.direction,
      fileCount: storageAttempt.fileCount,
      gistId: syncState?.gistId,
      statusDetail: storageAttempt.success
        ? `Storage ${storageAttempt.direction} succeeded`
        : `Storage ${storageAttempt.direction} failed`,
      ...base,
    };
  }

  if (syncState) {
    return {
      status: "synced",
      lastSyncTime: syncState.lastSyncTimestamp,
      lastSyncDirection: syncState.lastSyncDirection,
      fileCount: Object.keys(syncState.localChecksums).length,
      gistId: syncState.gistId,
      statusDetail: "GitHub Gist",
      ...base,
    };
  }

  if (gistAttempt) {
    return {
      status: gistAttempt.success ? "synced" : "error",
      lastSyncTime: gistAttempt.timestamp,
      lastSyncDirection: gistAttempt.direction,
      fileCount: gistAttempt.fileCount,
      gistId: undefined,
      statusDetail: gistAttempt.success
        ? `Gist ${gistAttempt.direction} succeeded`
        : `Gist ${gistAttempt.direction} failed`,
      ...base,
    };
  }

  return {
    status: "not-synced",
    lastSyncTime: undefined,
    lastSyncDirection: undefined,
    fileCount: 0,
    gistId: undefined,
    statusDetail: undefined,
    ...base,
  };
}
