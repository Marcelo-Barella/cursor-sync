let syncOperationActive = false;

export function isSyncOperationActive(): boolean {
  return syncOperationActive;
}

export function tryBeginSyncOperation(): boolean {
  if (syncOperationActive) {
    return false;
  }
  syncOperationActive = true;
  return true;
}

export function endSyncOperation(): void {
  syncOperationActive = false;
}
