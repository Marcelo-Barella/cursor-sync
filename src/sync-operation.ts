import type * as vscode from "vscode";

const STALE_SYNC_OPERATION_MS = 10 * 60 * 1000;

let syncOperationActive = false;
let syncOperationStartedAt: number | undefined;

export function isSyncOperationActive(): boolean {
  return syncOperationActive;
}

export function isSyncOperationStale(nowMs = Date.now()): boolean {
  return (
    syncOperationActive &&
    syncOperationStartedAt !== undefined &&
    nowMs - syncOperationStartedAt > STALE_SYNC_OPERATION_MS
  );
}

export function resetSyncOperation(): void {
  syncOperationActive = false;
  syncOperationStartedAt = undefined;
}

export function tryBeginSyncOperation(options?: { recoverStale?: boolean }): boolean {
  if (syncOperationActive) {
    if (options?.recoverStale || isSyncOperationStale()) {
      resetSyncOperation();
    } else {
      return false;
    }
  }
  syncOperationActive = true;
  syncOperationStartedAt = Date.now();
  return true;
}

async function refreshSyncUiAfterLatchChange(
  context: vscode.ExtensionContext
): Promise<void> {
  const { refreshSyncStatusBar } = await import("./sync-status-bar.js");
  const { refreshSidebar } = await import("./sidebar/index.js");
  await refreshSyncStatusBar(context);
  refreshSidebar();
}

export async function recoverSyncOperationLatch(
  context: vscode.ExtensionContext,
  options?: { force?: boolean }
): Promise<boolean> {
  if (!syncOperationActive) {
    return true;
  }
  if (options?.force || isSyncOperationStale()) {
    resetSyncOperation();
    await refreshSyncUiAfterLatchChange(context);
    return true;
  }
  return false;
}

export async function releaseSyncLatchForAuthRetry(
  context: vscode.ExtensionContext
): Promise<void> {
  resetSyncOperation();
  await refreshSyncUiAfterLatchChange(context);
}
