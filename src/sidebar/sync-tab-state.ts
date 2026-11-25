import type { SyncHistoryEntry } from "../types.js";
import type { E2eSidebarPhase, SyncTabState } from "./sync-tab.js";
import {
  activeScheduledRootHeldFingerprint,
  deriveStorageSyncPresentation,
  latestStorageHistoryEntry,
  storageSyncSidebarStatus,
  storageSyncSidebarStatusDetail,
} from "../storage-sync-ui-status.js";

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
  appSessionExpired?: boolean;
  e2ePhase?: E2eSidebarPhase;
  keysStatusMessage?: string;
  syncState?: {
    lastSyncTimestamp: string;
    lastSyncDirection: "push" | "pull";
    localChecksums: Record<string, string>;
    gistId: string;
  };
  isSyncOperationActive: boolean;
  activeHeldFingerprint?: string;
}): SyncTabState {
  const { history, appSessionActive, syncState, isSyncOperationActive } = input;
  const storageAttempt = latestAttemptForDestination(history, "cursor-sync-storage");
  const gistAttempt = latestAttemptForDestination(history, "github-gist");

  const base = {
    history,
    appSessionActive,
    appSessionExpired: input.appSessionExpired ?? false,
    e2ePhase: input.e2ePhase ?? "no_app_session",
    ...(input.keysStatusMessage ? { keysStatusMessage: input.keysStatusMessage } : {}),
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
    const presentation = deriveStorageSyncPresentation({
      history,
      activeHeldFingerprint: input.activeHeldFingerprint,
    });
    const sidebarStatus = storageSyncSidebarStatus(presentation);
    return {
      status: sidebarStatus,
      lastSyncTime: storageAttempt.timestamp,
      lastSyncDirection: storageAttempt.direction,
      fileCount: storageAttempt.fileCount,
      gistId: syncState?.gistId,
      statusDetail: storageSyncSidebarStatusDetail(presentation, storageAttempt),
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

export { latestStorageHistoryEntry };
