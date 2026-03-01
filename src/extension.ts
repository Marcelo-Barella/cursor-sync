import * as vscode from "vscode";
import { configureGithub, getToken } from "./auth.js";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { showStatus } from "./diagnostics.js";
import { resolveConflictsCommand } from "./conflicts.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { getLogger, loadSyncState } from "./diagnostics.js";
import { initializeSidebar } from "./sidebar.js";
import { initializeStatusBar, updateStatusBar } from "./statusbar.js";
import { getOrCreateClientId } from "./analytics.js";

let configListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = getLogger();

  initializeStatusBar(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.configureGithub", () =>
      configureGithub(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.push", () =>
      executePush(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pull", () =>
      executePull(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.showStatus", () =>
      showStatus(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.resolveConflicts", () =>
      resolveConflictsCommand(context)
    )
  );

  const sidebarProvider = initializeSidebar(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("cursorSync.sidebar", sidebarProvider)
  );

  updateConfiguredContext(context);
  getOrCreateClientId(context);
  startScheduler(context);

  configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cursorSync.schedule")) {
      stopScheduler();
      startScheduler(context);
    }
  });
  context.subscriptions.push(configListener);

  logger.appendLine(`[${new Date().toISOString()}] Cursor Sync activated`);
}

export function deactivate(): void {
  stopScheduler();
}

async function updateConfiguredContext(
  context: vscode.ExtensionContext
): Promise<void> {
  const token = await getToken(context);
  const isConfigured = token !== undefined;
  
  await vscode.commands.executeCommand(
    "setContext",
    "cursorSync.configured",
    isConfigured
  );

  if (isConfigured) {
    const syncState = await loadSyncState(context);
    const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
    updateStatusBar("ok", lastSync);
  } else {
    updateStatusBar("unconfigured");
  }
}
