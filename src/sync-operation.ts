import type * as vscode from "vscode";

const STALE_SYNC_OPERATION_MS = 10 * 60 * 1000;

let syncOperationActive = false;
let syncOperationStartedAt: number | undefined;

export function isSyncOperationActive(): boolean {
  return syncOperationActive;
}

export function isPushLocked(): boolean {
  return syncOperationActive;
}

export function isPullLocked(): boolean {
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

export function endSyncOperation(): void {
  resetSyncOperation();
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

export async function recoverSyncOperationLatch(
  context: vscode.ExtensionContext,
  options?: { force?: boolean }
): Promise<boolean> {
  if (!syncOperationActive) {
    return true;
  }
  if (options?.force || isSyncOperationStale()) {
    resetSyncOperation();
    const { refreshSyncStatusBar } = await import("./sync-status-bar.js");
    const { refreshSidebar } = await import("./sidebar/index.js");
    await refreshSyncStatusBar(context);
    refreshSidebar();
    return true;
  }
  return false;
}

export async function releaseSyncLatchForAuthRetry(
  context: vscode.ExtensionContext
): Promise<void> {
  resetSyncOperation();
  const { refreshSyncStatusBar } = await import("./sync-status-bar.js");
  const { refreshSidebar } = await import("./sidebar/index.js");
  await refreshSyncStatusBar(context);
  refreshSidebar();
}
