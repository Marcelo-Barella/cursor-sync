import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, saveSyncState, getLogger } from "./diagnostics.js";
import { resolveSyncRoots, gistFileNameToSyncKey } from "./paths.js";
import { computeChecksum } from "./packaging.js";
import { detectConflicts, clearConflicts, getResolutionForKey, getPendingConflicts } from "./conflicts.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import { findMissingExtensions } from "./extensions.js";
import type { SyncState, Manifest } from "./types.js";

let pullLock = false;

export async function executePull(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const logger = getLogger();

  if (pullLock) {
    vscode.window.showWarningMessage("A sync operation is already in progress.");
    return false;
  }

  pullLock = true;
  try {
    return await doPull(context);
  } finally {
    pullLock = false;
  }
}

async function doPull(context: vscode.ExtensionContext): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull started`);

  const syncState = await loadSyncState(context);
  let gistId = syncState?.gistId;

  const token = await requireToken(context);
  if (!token) {
    return false;
  }

  const client = new GistClient(token);

  if (!gistId) {
    const findResult = await withRetry(() => client.findExistingGist());
    if (!findResult.ok) {
      vscode.window.showErrorMessage(`Pull failed: ${findResult.error.message}`);
      logger.appendLine(
        `[${new Date().toISOString()}] Pull failed: ${findResult.error.category} - ${findResult.error.message}`
      );
      return false;
    }
    if (!findResult.data) {
      vscode.window.showErrorMessage(
        "Not configured. Push first or configure a Gist ID."
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull failed: not configured`);
      return false;
    }
    gistId = findResult.data;
    await saveSyncState(context, {
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "pull",
      gistId,
      localChecksums: {},
      remoteChecksums: {},
    });
  }

  const gistResult = await withRetry(() => client.getGist(gistId!));

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Pull failed: ${gistResult.error.message}`);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull failed: ${gistResult.error.category} - ${gistResult.error.message}`
    );
    return false;
  }

  const gistData = gistResult.data;
  const manifestFile = gistData.files["manifest.json"];
  if (!manifestFile) {
    vscode.window.showErrorMessage("Pull failed: manifest.json not found in Gist.");
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: missing manifest`);
    return false;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestFile.content) as Manifest;
  } catch {
    vscode.window.showErrorMessage("Pull failed: invalid manifest.json.");
    logger.appendLine(`[${new Date().toISOString()}] Pull failed: invalid manifest`);
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

  if (safeMode && filesToWrite.length > 0) {
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
      return false;
    }

    const selectedKeys = new Set(selected.map((s) => s.label));
    const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
    filesToWrite.length = 0;
    filesToWrite.push(...filtered);
  }

  if (filesToWrite.length === 0) {
    vscode.window.showInformationMessage("Pull complete: no files to update.");
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
    gistId: gistId!,
    localChecksums: { ...(syncState?.localChecksums ?? {}), ...newLocalChecksums },
    remoteChecksums: remoteChecksums,
  };
  await saveSyncState(context, newState);
  clearConflicts();

  checkMissingExtensions(gistData.files);

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

function checkMissingExtensions(
  gistFiles: Record<string, { content: string }>
): void {
  const extFile = gistFiles["cursor-user--extensions.json"];
  if (!extFile) {
    return;
  }

  try {
    const entries = JSON.parse(extFile.content) as Array<{ id: string; version: string }>;
    const missing = findMissingExtensions(entries);
    if (missing.length > 0) {
      const names = missing.map((m) => m.id).join(", ");
      vscode.window.showInformationMessage(
        `Extensions present remotely but not installed locally: ${names}`
      );
    }
  } catch {}
}
