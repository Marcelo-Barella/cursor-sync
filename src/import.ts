import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GistClient } from "./gist.js";
import { getToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { resolveSyncRoots, gistFileNameToSyncKey } from "./paths.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import type { Manifest } from "./types.js";

export async function executeImport(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Import started`);

  const input = await vscode.window.showInputBox({
    prompt: "Enter the Gist URL or ID to import settings from",
    placeHolder: "e.g., https://gist.github.com/username/1234567890abcdef or 1234567890abcdef",
  });

  if (!input) {
    logger.appendLine(`[${new Date().toISOString()}] Import cancelled: No input provided`);
    return;
  }

  const gistId = extractGistId(input);
  if (!gistId) {
    vscode.window.showErrorMessage("Invalid Gist URL or ID.");
    logger.appendLine(`[${new Date().toISOString()}] Import failed: Invalid input`);
    return;
  }

  const token = await getToken(context);
  const client = new GistClient(token);

  const gistResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching Gist data...",
      cancellable: false,
    },
    async () => {
      return await withRetry(() => client.getGist(gistId));
    }
  );

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Import failed: ${gistResult.error.message}`);
    logger.appendLine(
      `[${new Date().toISOString()}] Import failed: ${gistResult.error.category} - ${gistResult.error.message}`
    );
    return;
  }

  const gistData = gistResult.data;
  const manifestFile = gistData.files["manifest.json"];
  if (!manifestFile) {
    vscode.window.showErrorMessage("Import failed: manifest.json not found in Gist.");
    logger.appendLine(`[${new Date().toISOString()}] Import failed: missing manifest`);
    return;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestFile.content) as Manifest;
  } catch {
    vscode.window.showErrorMessage("Import failed: invalid manifest.json.");
    logger.appendLine(`[${new Date().toISOString()}] Import failed: invalid manifest`);
    return;
  }

  const roots = resolveSyncRoots();
  const availableFiles: Array<{ absolutePath: string; syncKey: string; content: Buffer }> = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === "manifest.json") {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
    if (!absolutePath) {
      continue;
    }

    const content =
      manifestEntry.encoding === "base64"
        ? Buffer.from(gistFile.content, "base64")
        : Buffer.from(gistFile.content, "utf-8");

    availableFiles.push({ absolutePath, syncKey, content });
  }

  if (availableFiles.length === 0) {
    vscode.window.showInformationMessage("No valid files found in Gist to import.");
    return;
  }

  const items = availableFiles.map((f) => ({
    label: f.syncKey,
    description: f.absolutePath,
    picked: true,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Select files to import",
    placeHolder: "Deselect files you do not want to import",
  });

  if (!selected || selected.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Import cancelled by user`);
    return;
  }

  const selectedKeys = new Set(selected.map((s) => s.label));
  const filesToWrite = availableFiles.filter((f) => selectedKeys.has(f.syncKey));

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
      "Import failed: file write error. Changes have been rolled back."
    );
    return;
  }

  await pruneOldBackups(context);

  vscode.window.showInformationMessage(
    `Import complete: ${filesToWrite.length} file(s) imported successfully.`
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Import succeeded: ${filesToWrite.length} files`
  );
}

function extractGistId(input: string): string | null {
  const match = input.match(/(?:gist\.github\.com\/[^\/]+\/|)([a-f0-9]{32}|[a-f0-9]{20})/i);
  return match ? match[1] : null;
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
