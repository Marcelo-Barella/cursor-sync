import * as vscode from "vscode";
import { configureGithub, getToken } from "./auth.js";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { executeExport } from "./export.js";
import { executeImport } from "./import.js";
import { executeExportTranscripts, executeImportTranscripts } from "./transcripts.js";
import {
  executeSaveChatLocal,
  executeLoadChatLocal,
  executeImportChatBundle,
  executeExportChatBundle,
  executeExportCurrentChatBundle,
  executeImportChatBundleActivate,
  executeVerifyChatImport,
} from "./chat-persistence.js";
import {
  executeExportChatToGist,
  executeExportCurrentChatBundleToGist,
} from "./export-gist-chat.js";
import { executeImportChatFromGist } from "./import-gist-chat.js";
import { executeSetChatEncryptionPassword } from "./chat-encryption-auth.js";
import {
  consumePendingAuthCallback,
  executeEnterAppAuthCode,
  executeLoginToCursorSync,
  executeLogoutAppSession,
  registerAppAuthUriHandler,
} from "./app-auth.js";
import {
  applyAppStorageBaselineRefresh,
  determineAppStorageSyncAction,
  executePullAppConfigs,
  executePushAppConfigs,
  fetchAppConfigs,
  hasAppSession,
  notifyAppStorageConflicts,
} from "./app-configs.js";
import { isAppConfigsFetchError } from "./app-config-fetch-errors.js";
import { setActiveExtensionContext } from "./extension-host-context.js";
import { executeImportTranscriptsFromGist } from "./import-gist-transcripts.js";
import { showStatus } from "./diagnostics.js";
import { resolveConflictsCommand } from "./conflicts.js";
import { executeReset } from "./reset.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { determineSyncAction } from "./scheduler.js";
import { getLogger, loadSyncState } from "./diagnostics.js";
import { refreshSyncCommandContextsAndStatusBar } from "./sync-context.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { initializeSidebar, refreshSidebar } from "./sidebar/index.js";
import { initializeStatusBar, updateStatusBar } from "./statusbar.js";
import { refreshSyncStatusBar } from "./sync-status-bar.js";
import {
  recoverSyncOperationLatch,
  resetSyncOperation,
  tryBeginSyncOperation,
} from "./sync-operation.js";
import { getOrCreateClientId } from "./analytics.js";
import {
  executeFinalizeStateReconciliation,
  executePrepareStateReconciliation,
  notifyPendingStateBundleIfAny,
} from "./state-reconciliation.js";
import { executePrepareSyncFromLandingZone } from "./sync-engine.js";
import {
  disposeActivationWatcher,
  registerActivationWatcher,
} from "./chat-import-activate-watcher.js";
import { flushPendingSidebarWriteback } from "./chat-import-sidebar-writeback.js";
import { executeInstallSkillTransportChat } from "./install-skill-transport-chat.js";
import { clearR2CredentialsCache } from "./app-r2-storage.js";
import { registerDeveloperUrlConfigurationListener } from "./config/urls.js";
let configListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = getLogger();
  setActiveExtensionContext(context);

  context.subscriptions.push(registerAppAuthUriHandler(context));
  consumePendingAuthCallback(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.refreshImportedTranscripts", () => {
      vscode.window.showInformationMessage(
        "Imported Transcripts moved to the Chats tab of the Cursor Sync sidebar."
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.openImportedTranscript", () => {
      vscode.window.showInformationMessage(
        "Imported Transcripts moved to the Chats tab of the Cursor Sync sidebar."
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.revealImportedTranscriptInExplorer", () => {
      vscode.window.showInformationMessage(
        "Imported Transcripts moved to the Chats tab of the Cursor Sync sidebar."
      );
    })
  );

  initializeStatusBar(context);
  resetSyncOperation();
  void refreshSyncStatusBar(context).then(() => refreshSidebar());

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.configureGithub", () =>
      configureGithub(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.loginToApp", () =>
      executeLoginToCursorSync(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.enterAppAuthCode", () =>
      executeEnterAppAuthCode(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.app.logout", () =>
      executeLogoutAppSession(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pullAppConfigs", () =>
      executePullAppConfigs(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.pushAppConfigs", () =>
      executePushAppConfigs(context)
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

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.reset", () =>
      executeReset(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.export", () =>
      executeExport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.import", () =>
      executeImport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportTranscripts", () =>
      executeExportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscripts", () =>
      executeImportTranscripts(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.saveChatLocal", () =>
      executeSaveChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.loadChatLocal", () =>
      executeLoadChatLocal(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatBundle", () =>
      executeImportChatBundle(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportChatBundle", () =>
      executeExportChatBundle(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportCurrentChatBundle", (target) =>
      executeExportCurrentChatBundle(context, target)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatBundleActivate", () =>
      executeImportChatBundleActivate(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.verifyChatImport", () =>
      executeVerifyChatImport(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportChatToGist", () =>
      executeExportChatToGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.exportCurrentChatBundleToGist", (target) =>
      executeExportCurrentChatBundleToGist(context, target)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importChatFromGist", () =>
      executeImportChatFromGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.setChatEncryptionPassword", () =>
      executeSetChatEncryptionPassword(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.installSkillTransportChat", () =>
      executeInstallSkillTransportChat(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.importTranscriptsFromGist", () =>
      executeImportTranscriptsFromGist(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.syncNow", () =>
      executeSyncNow(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareStateReconciliation", () =>
      executePrepareStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.finalizeStateReconciliation", () =>
      executeFinalizeStateReconciliation(context)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorSync.prepareSyncFromLandingZone", () =>
      executePrepareSyncFromLandingZone(context)
    )
  );

  const sidebarProvider = initializeSidebar(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cursorSync.sidebar", sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  void refreshSyncCommandContextsAndStatusBar(context);
  getOrCreateClientId(context);
  startScheduler(context);

  configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cursorSync.schedule")) {
      stopScheduler();
      startScheduler(context);
    }
  });
  context.subscriptions.push(configListener);

  context.subscriptions.push(
    registerDeveloperUrlConfigurationListener(() => {
      clearR2CredentialsCache();
    })
  );

  void notifyPendingStateBundleIfAny(context);

  void flushPendingSidebarWriteback(context).then((applied) => {
    if (applied) {
      logger.appendLine(
        `[${new Date().toISOString()}] Applied pending chat import sidebar write-back after reload`
      );
    }
  });

  registerActivationWatcher(context);

  logger.appendLine(`[${new Date().toISOString()}] Cursor Sync activated`);
}

export function deactivate(): void {
  disposeActivationWatcher();
  stopScheduler();
  resetSyncOperation();
}

export async function executeSyncNow(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Sync Now triggered`);

  if (!tryBeginSyncOperation()) {
    await recoverSyncOperationLatch(context, { force: true });
    if (!tryBeginSyncOperation()) {
      vscode.window.showWarningMessage("A sync operation is already in progress.");
      await refreshSyncStatusBar(context);
      refreshSidebar();
      return;
    }
  }

  const appSessionActive = await hasAppSession(context);
  updateStatusBar("syncing", {
    destination: appSessionActive ? "cursor-sync-storage" : "github-gist",
  });
  refreshSidebar();

  const lockedSyncOptions = {
    skipOperationLock: true as const,
    trigger: "syncNow" as const,
  };
  let syncFailed = false;
  try {
    const result = appSessionActive
      ? await determineAppStorageSyncAction(context, { trigger: "syncNow" })
      : await determineSyncAction(context);
    switch (result.action) {
      case "none":
        vscode.window.showInformationMessage("Already in sync, nothing to do.");
        break;
      case "blocked":
        vscode.window.showWarningMessage(result.message);
        break;
      case "baseline_refresh": {
        const remote = await fetchAppConfigs(context, { trigger: "syncNow" });
        if (remote) {
          await applyAppStorageBaselineRefresh(
            context,
            result.keys,
            remote.updated_at
          );
        }
        break;
      }
      case "pull":
        if (
          !(await executePull(context, {
            ...lockedSyncOptions,
            keys: "keys" in result ? (result.keys as string[]) : undefined,
            remoteDeletions:
              "remoteDeletions" in result
                ? (result.remoteDeletions as string[])
                : undefined,
          }))
        ) {
          syncFailed = true;
        }
        break;
      case "push":
        if (
          !(await executePush(context, {
            ...lockedSyncOptions,
            keys: "keys" in result ? (result.keys as string[]) : undefined,
            deletions: "deletions" in result ? (result.deletions as string[]) : undefined,
          }))
        ) {
          syncFailed = true;
        }
        break;
      case "pull-push": {
        const pullOk = await executePull(context, {
          ...lockedSyncOptions,
          keys: "pullKeys" in result ? (result.pullKeys as string[]) : undefined,
          remoteDeletions:
            "remoteDeletions" in result
              ? (result.remoteDeletions as string[])
              : undefined,
        });
        if (!pullOk) {
          syncFailed = true;
          break;
        }
        if (
          !(await executePush(context, {
            ...lockedSyncOptions,
            keys: "pushKeys" in result ? (result.pushKeys as string[]) : undefined,
            deletions:
              "deletions" in result ? (result.deletions as string[]) : undefined,
          }))
        ) {
          syncFailed = true;
        }
        break;
      }
      case "conflict": {
        syncFailed = true;
        if (appSessionActive) {
          await notifyAppStorageConflicts(context, result.keys, {
            trigger: "syncNow",
          });
          break;
        }
        const conflictMessage = `${result.keys.length} conflict(s) detected. Resolve them first.`;
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("syncNow", "syncNow", conflictMessage, {
            category: "CONFLICT",
            conflictCount: result.keys.length,
          }),
          { level: "warning", title: conflictMessage }
        );
        vscode.commands.executeCommand("cursorSync.resolveConflicts");
        break;
      }
      case "error": {
        syncFailed = true;
        if (result.reason === "session_expired") {
          break;
        }
        const errorMessage = `Sync failed: ${result.reason}`;
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("syncNow", "syncNow", result.reason, {
            category: result.reason,
          }),
          { title: errorMessage }
        );
        break;
      }
    }
  } catch (err) {
    syncFailed = true;
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Sync Now failed: ${errMessage}`
    );
    if (!isAppConfigsFetchError(err)?.historyRecorded) {
      const errorMessage = `Sync failed: ${errMessage}`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("syncNow", "syncNow", errMessage),
        { title: errorMessage }
      );
    } else {
      vscode.window.showErrorMessage(errMessage);
    }
  } finally {
    resetSyncOperation();
    await refreshSyncStatusBar(context, syncFailed ? { failed: true } : undefined);
    refreshSidebar();
  }
}
