import * as vscode from "vscode";
import { getToken } from "./auth.js";
import { hasAppSession } from "./app-configs.js";
import { loadSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";

export async function refreshSyncCommandContexts(
  context: vscode.ExtensionContext
): Promise<void> {
  const token = await getToken(context);
  const isConfigured = token !== undefined;
  const appSessionActive = await hasAppSession(context);

  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.configured",
    isConfigured
  );
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.appSessionActive",
    appSessionActive
  );
}

export async function refreshSyncCommandContextsAndStatusBar(
  context: vscode.ExtensionContext
): Promise<void> {
  await refreshSyncCommandContexts(context);
  const token = await getToken(context);
  if (token !== undefined) {
    const syncState = await loadSyncState(context);
    const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
    updateStatusBar("ok", lastSync);
  } else if (await hasAppSession(context)) {
    updateStatusBar("ok");
  } else {
    updateStatusBar("unconfigured");
  }
}
