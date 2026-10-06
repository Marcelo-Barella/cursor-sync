import * as vscode from "vscode";
import { nodePlatform } from "./os-runtime.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger, addSyncHistoryEntry } from "./diagnostics.js";
import { resolveSyncRoots, gistFileNameToSyncKey } from "./paths.js";
import { computeChecksum } from "./packaging.js";
import { detectConflicts, clearConflicts, getResolutionForKey, getPendingConflicts } from "./conflicts.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import { findMissingExtensions, findExtraExtensions } from "./extensions.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSyncStatusBar } from "./sync-status-bar.js";
import {
  tryBeginSyncOperation,
  recoverSyncOperationLatch,
  resetSyncOperation,
} from "./sync-operation.js";
import { refreshSidebar } from "./sidebar/index.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";
import type { SyncState, Manifest } from "./types.js";
import { hasAppSession, executePullAppConfigs } from "./app-configs.js";
import {
  formatPullEmptyToast,
  formatPullSuccessToast,
  SYNC_DESTINATION_GIST_LABEL,
} from "./sync-destination.js";

export type PullTrigger = "manual" | "scheduled" | "syncNow" | "startup";

export type PullOptions = {
  trigger?: PullTrigger | import("./app-configs.js").AppConfigsSyncTrigger;
  skipOperationLock?: boolean;
  keys?: string[];
  remoteDeletions?: string[];
};

export type ExecutePullResult =
  | { status: "success" }
  | { status: "held" }
  | { status: "failure" };

export function executePullSucceeded(result: ExecutePullResult): boolean {
  return result.status === "success";
}

export async function executePull(
  context: vscode.ExtensionContext,
  options?: PullOptions
): Promise<ExecutePullResult> {
  const trigger = options?.trigger ?? "manual";
  const skipOperationLock = options?.skipOperationLock === true;
  let result: ExecutePullResult = { status: "success" };

  if (!skipOperationLock) {
    if (!tryBeginSyncOperation()) {
      await recoverSyncOperationLatch(context, { force: true });
      if (!tryBeginSyncOperation()) {
        vscode.window.showWarningMessage("A sync operation is already in progress.");
        result = { status: "failure" };
        return result;
      }
    }
    if (await hasAppSession(context)) {
      updateStatusBar("syncing", { destination: "cursor-sync-storage" });
    } else {
      updateStatusBar("syncing", { destination: "github-gist" });
    }
  }

  let failed = false;
  try {
    if (await hasAppSession(context)) {
      const pullStatus = await executePullAppConfigs(context, {
        trigger: trigger as import("./app-configs.js").AppConfigsSyncTrigger,
        keys: options?.keys,
        remoteDeletions: options?.remoteDeletions,
      });
      if (pullStatus === "held") {
        result = { status: "held" };
      } else if (pullStatus === "failure") {
        result = { status: "failure" };
      } else {
        result = { status: "success" };
      }
      failed = result.status === "failure";
      return result;
    }
    const gistTrigger =
      trigger === "syncNow" || trigger === "startup" ? "manual" : trigger;
    const success = await doPull(context, gistTrigger);
    result = success ? { status: "success" } : { status: "failure" };
    failed = !success;
    return result;
  } catch (err) {
    failed = true;
    result = { status: "failure" };
    throw err;
  } finally {
    if (!skipOperationLock) {
      resetSyncOperation();
      const barOpts =
        result.status === "failure"
          ? { failed: true }
          : result.status === "held"
            ? { held: true }
            : undefined;
      await refreshSyncStatusBar(context, barOpts);
      refreshSidebar();
    }
  }
}

async function doPull(
  context: vscode.ExtensionContext,
  trigger: PullTrigger = "manual"
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull started (trigger=${trigger})`);

  let syncState = await loadSyncState(context);
  let gistId = syncState?.gistId;

  const token = await requireToken(context);
  if (!token) {
    const authFailedMessage =
      "GitHub token not configured. Configure your token to sync.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, authFailedMessage, {
        direction: "pull",
        category: "AUTH_FAILED",
      }),
      { title: authFailedMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: AUTH_FAILED`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
    return false;
  }

  const client = new GistClient(token);

  if (!gistId) {
    const existingResult = await withRetry(() => client.findExistingGist());
    if (!existingResult.ok) {
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, existingResult.error.message, {
          direction: "pull",
          category: existingResult.error.category,
          statusCode: existingResult.error.statusCode,
        }),
        { title: `Pull failed: ${existingResult.error.message}` }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: ${existingResult.error.category} - ${existingResult.error.message}`);
      sendEvent(context, "sync_failed", {
        direction: "pull",
        reason: existingResult.error.category,
        status_code: existingResult.error.statusCode,
        trigger,
      });
      return false;
    }

    if (existingResult.data) {
      gistId = existingResult.data.id;
      syncState = {
        lastSyncTimestamp: new Date().toISOString(),
        lastSyncDirection: "pull",
        gistId: gistId,
        localChecksums: syncState?.localChecksums || {},
        remoteChecksums: syncState?.remoteChecksums || {}
      };
      await saveSyncState(context, syncState);
      logger.appendLine(`[${new Date().toISOString()}] Found existing Gist: ${gistId}`);
    } else {
      const notConfiguredMessage =
        "Not configured. Push first or configure a Gist ID.";
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, notConfiguredMessage, {
          direction: "pull",
          category: "not_configured",
        }),
        { title: notConfiguredMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: not configured`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
      return false;
    }
  }

  const gistResult = await withRetry(() => client.getGist(gistId));

  if (!gistResult.ok) {
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, gistResult.error.message, {
        direction: "pull",
        category: gistResult.error.category,
        statusCode: gistResult.error.statusCode,
      }),
      { title: `Pull from ${SYNC_DESTINATION_GIST_LABEL} failed: ${gistResult.error.message}` }
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull failed: ${gistResult.error.category} - ${gistResult.error.message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
      destination: "github-gist",
      error: gistResult.error.message,
    });
    sendEvent(context, "sync_failed", {
      direction: "pull",
      reason: gistResult.error.category,
      status_code: gistResult.error.statusCode,
      trigger,
    });
    return false;
  }

  const gistData = gistResult.data;
  const manifestFile = gistData.files["manifest.json"];
  if (!manifestFile) {
    const message =
      gistData.files[TRANSCRIPT_MANIFEST_FILE_NAME] !== undefined
        ? "Pull failed: This Gist contains agent transcripts, not settings. Update the configured Gist to one from Cursor Sync export/push, or use Cursor Sync: Import Agent Transcripts from Private Gist."
        : "Pull failed: manifest.json not found in Gist.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, message, {
        direction: "pull",
        category: "missing_manifest",
      }),
      { title: message }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: missing manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "missing_manifest", trigger });
    return false;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestFile.content) as Manifest;
  } catch {
    const invalidManifestMessage = "Pull failed: invalid manifest.json.";
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, invalidManifestMessage, {
        direction: "pull",
        category: "invalid_manifest",
      }),
      { title: invalidManifestMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: invalid manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "invalid_manifest", trigger });
    return false;
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  const conflicts = await detectConflicts(context, remoteChecksums);
  if (conflicts.length > 0) {
    const unresolved = conflicts.filter((c) => {
      const resolution = getResolutionForKey(c.relativeSyncKey);
      return !resolution || resolution === "skip";
    });
    if (unresolved.length > 0) {
      const conflictMessage = `${unresolved.length} conflict(s) detected. Resolve them before pulling.`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("pull", trigger, conflictMessage, {
          direction: "pull",
          category: "CONFLICT",
          conflictCount: unresolved.length,
        }),
        { level: "warning", title: conflictMessage }
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull blocked: CONFLICT`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "CONFLICT", trigger });
      return false;
    }
  }

  const roots = resolveSyncRoots(nodePlatform(), context);
  const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === "manifest.json") {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    if (conflicts.length > 0) {
      const resolution = getResolutionForKey(syncKey);
      if (resolution === "keepLocal") {
        continue;
      }
    }

    const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
    if (!absolutePath) {
      continue;
    }

    const content =
      manifestEntry.encoding === "base64"
        ? Buffer.from(gistFile.content, "base64")
        : Buffer.from(gistFile.content, "utf-8");

    filesToWrite.push({ absolutePath, syncKey, content });
  }

  const config = vscode.workspace.getConfiguration("cursorSync");
  const safeMode = config.get<boolean>("safeMode") ?? true;

  if (trigger === "manual" && safeMode && filesToWrite.length > 0) {
    const items = filesToWrite.map((f) => ({
      label: f.syncKey,
      picked: true,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Files to overwrite",
      placeHolder: "Deselect files you do not want to overwrite",
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Pull cancelled by user`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "cancelled", trigger });
      return false;
    }

    const selectedKeys = new Set(selected.map((s) => s.label));
    const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
    filesToWrite.length = 0;
    filesToWrite.push(...filtered);
  }

  if (filesToWrite.length === 0) {
    if (trigger === "manual") {
      vscode.window.showInformationMessage(formatPullEmptyToast("github-gist"));
    }
    sendEvent(context, "sync_completed", { direction: "pull", file_count: 0, trigger });
    return true;
  }

  const { entries: backupEntries } = await createBackup(
    context,
    filesToWrite.map((f) => f.absolutePath)
  );

  const writtenBackups: typeof backupEntries = [];
  let writeError = false;

  for (const file of filesToWrite) {
    try {
      const dir = path.dirname(file.absolutePath);
      await fs.mkdir(dir, { recursive: true });
      const tmpPath = file.absolutePath + ".tmp";
      await fs.writeFile(tmpPath, file.content);
      await fs.rename(tmpPath, file.absolutePath);
      const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
      if (backup) {
        writtenBackups.push(backup);
      }
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Write failed for ${file.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
      );
      writeError = true;
      break;
    }
  }

  if (writeError) {
    logger.appendLine(`[${new Date().toISOString()}] Rolling back partial writes`);
    await rollbackFromBackup(writtenBackups);
    const writeErrorMessage = `Pull from ${SYNC_DESTINATION_GIST_LABEL} failed: file write error. Changes have been rolled back.`;
    void showSyncFailureWithDebug(
      context,
      buildSyncDebugFailure("pull", trigger, writeErrorMessage, {
        direction: "pull",
        category: "FILE_SYSTEM_ERROR",
      }),
      { title: writeErrorMessage }
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: FILE_SYSTEM_ERROR`);
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
      destination: "github-gist",
      error: "File write error",
    });
    sendEvent(context, "sync_failed", { direction: "pull", reason: "FILE_SYSTEM_ERROR", trigger });
    return false;
  }

  await pruneOldBackups(context);

  const newLocalChecksums: Record<string, string> = {};
  for (const file of filesToWrite) {
    newLocalChecksums[file.syncKey] = computeChecksum(file.content);
  }

  const newState: SyncState = {
    lastSyncTimestamp: new Date().toISOString(),
    lastSyncDirection: "pull",
    gistId: syncState?.gistId || gistId,
    localChecksums: { ...(syncState?.localChecksums || {}), ...newLocalChecksums },
    remoteChecksums: remoteChecksums,
  };
  await saveSyncState(context, newState);
  clearConflicts();

  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: filesToWrite.length,
    success: true,
    destination: "github-gist",
  });
  sendEvent(context, "sync_completed", {
    direction: "pull",
    file_count: filesToWrite.length,
    trigger,
  });
  await syncExtensionsAfterPull(gistData.files, logger);

  vscode.window.showInformationMessage(
    formatPullSuccessToast(filesToWrite.length, "github-gist")
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Pull succeeded: ${filesToWrite.length} files`
  );
  return true;
}

function syncKeyToAbsolutePath(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }

  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }

  return undefined;
}

const CONCURRENT_INSTALLS = 2;

async function syncExtensionsAfterPull(
  gistFiles: Record<string, { content: string }>,
  logger: vscode.OutputChannel
): Promise<void> {
  const extFile = gistFiles["cursor-user--extensions.json"];
  if (!extFile) {
    return;
  }

  let entries: Array<{ id: string; version: string }>;
  try {
    entries = JSON.parse(extFile.content) as Array<{ id: string; version: string }>;
  } catch {
    return;
  }

  const config = vscode.workspace.getConfiguration("cursorSync");
  const autoInstall = config.get<boolean>("syncExtensions.autoInstall") ?? true;
  const autoUninstall = config.get<boolean>("syncExtensions.autoUninstall") ?? false;

  const missing = findMissingExtensions(entries);
  if (autoInstall && missing.length > 0) {
    for (let i = 0; i < missing.length; i += CONCURRENT_INSTALLS) {
      const batch = missing.slice(i, i + CONCURRENT_INSTALLS);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            await vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              entry.id
            );
          } catch (err) {
            logger.appendLine(
              `[${new Date().toISOString()}] Failed to install extension ${entry.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );
    }
  } else if (!autoInstall && missing.length > 0) {
    const names = missing.map((m) => m.id).join(", ");
    vscode.window.showInformationMessage(
      `Extensions present remotely but not installed locally: ${names}`
    );
  }

  const extras = findExtraExtensions(entries);
  if (extras.length === 0) {
    return;
  }

  let shouldUninstall = autoUninstall;
  if (!shouldUninstall) {
    const choice = await vscode.window.showWarningMessage(
      `Remove ${extras.length} extension(s) that are not in the synced list?`,
      "Yes",
      "No"
    );
    shouldUninstall = choice === "Yes";
  }

  if (!shouldUninstall) {
    return;
  }

  for (const id of extras) {
    try {
      await vscode.commands.executeCommand(
        "workbench.extensions.uninstallExtension",
        id
      );
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Failed to uninstall extension ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
