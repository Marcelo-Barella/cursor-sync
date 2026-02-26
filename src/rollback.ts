import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";

const MAX_BACKUPS = 3;

export interface BackupEntry {
  absolutePath: string;
  backupPath: string;
}

export async function createBackup(
  context: vscode.ExtensionContext,
  filePaths: string[]
): Promise<{ backupDir: string; entries: BackupEntry[] }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(
    context.globalStorageUri.fsPath,
    "backups",
    timestamp
  );
  await fs.mkdir(backupDir, { recursive: true });

  const entries: BackupEntry[] = [];

  for (const absPath of filePaths) {
    try {
      await fs.access(absPath);
      const relative = absPath.replace(/[/\\]/g, "--");
      const backupPath = path.join(backupDir, relative);
      await fs.copyFile(absPath, backupPath);
      entries.push({ absolutePath: absPath, backupPath });
    } catch {
      // File doesn't exist yet, no backup needed
    }
  }

  return { backupDir, entries };
}

export async function rollbackFromBackup(entries: BackupEntry[]): Promise<void> {
  const logger = getLogger();
  for (const entry of entries) {
    try {
      await fs.copyFile(entry.backupPath, entry.absolutePath);
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Rollback failed for ${entry.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export async function pruneOldBackups(
  context: vscode.ExtensionContext
): Promise<void> {
  const backupsRoot = path.join(context.globalStorageUri.fsPath, "backups");

  let dirs: string[];
  try {
    dirs = await fs.readdir(backupsRoot);
  } catch {
    return;
  }

  dirs.sort();

  if (dirs.length <= MAX_BACKUPS) {
    return;
  }

  const toDelete = dirs.slice(0, dirs.length - MAX_BACKUPS);
  for (const dir of toDelete) {
    try {
      await fs.rm(path.join(backupsRoot, dir), { recursive: true, force: true });
    } catch {}
  }
}
