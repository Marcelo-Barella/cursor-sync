import type * as vscode from "vscode";
import { getToken } from "./auth.js";
import { loadSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { isSyncOperationActive } from "./sync-operation.js";

export async function refreshSyncStatusBar(
  context: vscode.ExtensionContext,
  options?: { failed?: boolean }
): Promise<void> {
  if (isSyncOperationActive()) {
    updateStatusBar("syncing");
    return;
  }

  if (options?.failed) {
    updateStatusBar("error", new Date());
    return;
  }

  const token = await getToken(context);
  if (!token) {
    updateStatusBar("unconfigured");
    return;
  }

  const syncState = await loadSyncState(context);
  updateStatusBar(
    "ok",
    syncState ? new Date(syncState.lastSyncTimestamp) : undefined
  );
}
