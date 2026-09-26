import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { enumerateSyncFiles, syncKeyToGistFileName } from "./paths.js";
import { packageFiles, computeChecksum } from "./packaging.js";
import { GistClient } from "./gist.js";
import { requireToken, validateStoredToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { detectConflicts, clearConflicts, getPendingConflicts, getResolutionForKey } from "./conflicts.js";
import { generateExtensionsJson } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSyncStatusBar } from "./sync-status-bar.js";
import {
  tryBeginSyncOperation,
  endSyncOperation,
} from "./sync-operation.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import type { SyncState } from "./types.js";

export type PushTrigger = "manual" | "scheduled";

export { isPushLocked } from "./sync-operation.js";

export async function executePush(
  context: vscode.ExtensionContext,
  options?: { trigger?: PushTrigger }
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const logger = getLogger();

  if (!tryBeginSyncOperation()) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  updateStatusBar("syncing");
  let failed = false;
  try {
    const success = await doPush(context, trigger);
    failed = !success;
    return success;
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    endSyncOperation();
    await refreshSyncStatusBar(context, failed ? { failed: true } : undefined);
    refreshSidebar();
  }
}

async function doPush(
  context: vscode.ExtensionContext,
  trigger: PushTrigger = "manual"
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push started`);

  const authFailedMessage =
    "GitHub token not configured. Configure your token to sync.";

  if (!(await validateStoredToken(context))) {
    const token = await requireToken(context);
    if (!token) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, authFailedMessage, {
          direction: "push",
          category: "AUTH_FAILED",
        }),
        { title: authFailedMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Push failed: AUTH_FAILED`);
      sendEvent(context, "sync_failed", { direction: "push", reason: "AUTH_FAILED", trigger });
      return false;
    }
  }

  const token = await requireToken(context);
  if (!token) {
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("push", trigger, authFailedMessage, {
        direction: "push",
        category: "AUTH_FAILED",
      }),
      { title: authFailedMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Push failed: AUTH_FAILED`);
    sendEvent(context, "sync_failed", { direction: "push", reason: "AUTH_FAILED", trigger });
    return false;
  }

  const client = new GistClient(token);
  const syncState = await loadSyncState(context);

  if (syncState) {
    const remoteChecksums = syncState.remoteChecksums;
    const conflicts = await detectConflicts(context, remoteChecksums);
    if (conflicts.length > 0) {
      const unresolved = conflicts.filter((c) => {
        const resolution = getResolutionForKey(c.relativeSyncKey);
        return !resolution || resolution === "skip";
      });
      if (unresolved.length > 0) {
        const conflictMessage = `${unresolved.length} conflict(s) detected. Resolve them before pushing.`;
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("push", trigger, conflictMessage, {
            direction: "push",
            category: "CONFLICT",
            conflictCount: unresolved.length,
          }),
          { level: "warning", title: conflictMessage }
        );
        logger.appendLine(`[${new Date().toISOString()}] Push blocked: CONFLICT`);
        sendEvent(context, "sync_failed", { direction: "push", reason: "CONFLICT", trigger });
        return false;
      }
    }
  }

  const extensionsJson = generateExtensionsJson();
  const cursorUserRoot = (await import("./paths.js")).resolveSyncRoots().cursorUser;
  await writeExtensionsFile(cursorUserRoot, extensionsJson);

  const files = await enumerateSyncFiles();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest } = await packageFiles(files, profileName);

  const gistFiles: Record<string, { content: string }> = {};
  gistFiles["manifest.json"] = { content: JSON.stringify(manifest, null, 2) };

  for (const [key, value] of packaged) {
    const gistFileName = syncKeyToGistFileName(key);
    gistFiles[gistFileName] = { content: value.content };
  }

  let gistId = syncState?.gistId;
  let isNewGist = false;

  if (!gistId) {
    const existingResult = await withRetry(() => client.findExistingGist());
    if (existingResult.ok && existingResult.data) {
      gistId = existingResult.data.id;
    }
  }

  if (!gistId) {
    const result = await withRetry(() =>
      client.createGist(gistFiles, "Cursor Sync - Settings Backup")
    );
    if (!result.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, result.error.message, {
          direction: "push",
          category: result.error.category,
          statusCode: result.error.statusCode,
        }),
        { title: `Push failed: ${result.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Push failed: ${result.error.category} - ${result.error.message}`
      );
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        error: result.error.message,
      });
      sendEvent(context, "sync_failed", {
        direction: "push",
        reason: result.error.category,
        trigger,
        status_code: result.error.statusCode,
      });
      return false;
    }
    gistId = result.data.id;
    isNewGist = true;
  } else {
    const existingResult = await withRetry(() => client.getGist(gistId!));
    let filesToDelete: Record<string, null> = {};
    if (existingResult.ok) {
      const existingFiles = Object.keys(existingResult.data.files);
      for (const existing of existingFiles) {
        if (existing !== "manifest.json" && !gistFiles[existing]) {
          filesToDelete[existing] = null;
        }
      }
    }

    const updatePayload: Record<string, { content: string } | null> = {
      ...gistFiles,
      ...filesToDelete,
    };

    const result = await withRetry(() =>
      client.updateGist(gistId!, updatePayload)
    );
    if (!result.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("push", trigger, result.error.message, {
          direction: "push",
          category: result.error.category,
          statusCode: result.error.statusCode,
        }),
        { title: `Push failed: ${result.error.message}` }
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Push failed: ${result.error.category} - ${result.error.message}`
      );
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        error: result.error.message,
      });
      sendEvent(context, "sync_failed", {
        direction: "push",
        reason: result.error.category,
        trigger,
        status_code: result.error.statusCode,
      });
      return false;
    }
  }

  const checksums: Record<string, string> = {};
  for (const [key, value] of packaged) {
    checksums[key] = value.checksum;
  }

  const newState: SyncState = {
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncDirection: "push",
    gistId: gistId!,
    localChecksums: checksums,
    remoteChecksums: checksums,
  };
  await saveSyncState(context, newState);
  clearConflicts();

  const fileCount = packaged.size;
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "push",
    trigger,
    fileCount,
    success: true,
  });
  sendEvent(context, "sync_completed", {
    direction: "push",
    file_count: fileCount,
    trigger,
    is_new_gist: isNewGist,
  });
  vscode.window.showInformationMessage(
    `Push complete: ${fileCount} file(s) synced.`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Push succeeded: ${fileCount} files`
  );
  return true;
}

async function writeExtensionsFile(
  cursorUserRoot: string,
  content: string
): Promise<string> {
  const filePath = (await import("node:path")).join(
    cursorUserRoot,
    "extensions.json"
  );
  const dir = (await import("node:path")).dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
