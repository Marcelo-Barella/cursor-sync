import * as vscode from "vscode";
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
import { refreshSidebar } from "./sidebar.js";
import { sendEvent } from "./analytics.js";
import type { SyncState, Manifest } from "./types.js";

export type PullTrigger = "manual" | "scheduled";

let pullLock = false;

export function isPullLocked(): boolean {
  return pullLock;
}

export async function executePull(
  context: vscode.ExtensionContext,
  options?: { trigger?: PullTrigger }
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const logger = getLogger();

  if (pullLock) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  pullLock = true;
  updateStatusBar("syncing");
  try {
    const success = await doPull(context, trigger);
    updateStatusBar(success ? "ok" : "error", new Date());
    refreshSidebar();
    return success;
  } catch (err) {
    updateStatusBar("error", new Date());
    refreshSidebar();
    throw err;
  } finally {
    pullLock = false;
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
    sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
    return false;
  }

  const client = new GistClient(token);

  if (!gistId) {
    const existingResult = await withRetry(() => client.findExistingGist());
    if (!existingResult.ok) {
      vscode.window.showErrorMessage(`Pull failed: ${existingResult.error.message}`);
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
      vscode.window.showErrorMessage(
        "Not configured. Push first or configure a Gist ID."
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: not configured`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "not_configured", trigger });
      return false;
    }
  }

  const gistResult = await withRetry(() => client.getGist(gistId));

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Pull failed: ${gistResult.error.message}`);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull failed: ${gistResult.error.category} - ${gistResult.error.message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
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
    vscode.window.showErrorMessage("Pull failed: manifest.json not found in Gist.");
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: missing manifest`);
    sendEvent(context, "sync_failed", { direction: "pull", reason: "missing_manifest", trigger });
    return false;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestFile.content) as Manifest;
  } catch {
    vscode.window.showErrorMessage("Pull failed: invalid manifest.json.");
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
      vscode.window.showWarningMessage(
        `${unresolved.length} conflict(s) detected. Resolve them before pulling.`
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull blocked: CONFLICT`);
      sendEvent(context, "sync_failed", { direction: "pull", reason: "CONFLICT", trigger });
      return false;
    }
  }

  const roots = resolveSyncRoots();
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
      vscode.window.showInformationMessage("Pull complete: no files to update.");
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
    vscode.window.showErrorMessage(
      "Pull failed: file write error. Changes have been rolled back."
    );
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: FILE_SYSTEM_ERROR`);
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
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
  });
  sendEvent(context, "sync_completed", {
    direction: "pull",
    file_count: filesToWrite.length,
    trigger,
  });
  await syncExtensionsAfterPull(gistData.files, logger);

  vscode.window.showInformationMessage(
    `Pull complete: ${filesToWrite.length} file(s) updated.`
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
