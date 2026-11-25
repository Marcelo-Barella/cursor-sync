import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { resolveSyncRoots } from "./paths.js";
import { resolveSyncRootsRealpaths, assertContainedSyncPath } from "./app-config-sync-path-safety.js";
import type { PullJournal, PullJournalEntry } from "./app-config-pull-journal.js";

export interface JournalValidationResult {
  ok: boolean;
  reason?: string;
}

export function expectedBackupDirForJournal(
  context: vscode.ExtensionContext,
  journalId: string
): string {
  return path.join(
    context.globalStorageUri.fsPath,
    "backups",
    `app-config-pull-${journalId}`
  );
}

export async function validatePullJournalForReplay(
  context: vscode.ExtensionContext,
  journal: PullJournal
): Promise<JournalValidationResult> {
  if (!journal.id || journal.id.length < 8) {
    return { ok: false, reason: "invalid journal id" };
  }
  const expectedBackup = expectedBackupDirForJournal(context, journal.id);
  const backupReal = path.resolve(journal.backupDir);
  if (backupReal !== path.resolve(expectedBackup)) {
    return { ok: false, reason: "backupDir does not match configured storage" };
  }
  if (journal.resolvedRoots) {
    const roots = resolveSyncRoots();
    const current = await resolveSyncRootsRealpaths(roots);
    if (
      path.resolve(journal.resolvedRoots.cursorUser) !== path.resolve(current.cursorUser) ||
      path.resolve(journal.resolvedRoots.dotCursor) !== path.resolve(current.dotCursor)
    ) {
      return { ok: false, reason: "journal roots do not match current sync roots" };
    }
  }

  const resolved = await resolveSyncRootsRealpaths(resolveSyncRoots());

  for (const entry of journal.entries) {
    if (path.isAbsolute(entry.backupPath ?? "") && entry.backupPath) {
      if (!entry.backupPath.startsWith(expectedBackup + path.sep)) {
        return { ok: false, reason: "absolute backup path outside journal backup dir" };
      }
    }
    if (entry.backupPath) {
      const base = path.basename(entry.backupPath);
      const joined = path.join(expectedBackup, base);
      if (path.resolve(entry.backupPath) !== path.resolve(joined)) {
        return { ok: false, reason: "backup path escapes journal backup dir" };
      }
      if (!entry.createdByPull) {
        try {
          await fs.access(entry.backupPath);
        } catch {
          return { ok: false, reason: "backup file missing" };
        }
      }
    }
    try {
      await assertContainedSyncPath(entry.absolutePath, entry.syncKey, resolved);
    } catch {
      return { ok: false, reason: `entry outside sync root: ${entry.syncKey}` };
    }
  }

  return { ok: true };
}

export function entryMatchesRemoteOrPrePull(
  entry: PullJournalEntry,
  currentChecksum: string
): boolean {
  if (entry.wroteChecksum && currentChecksum === entry.wroteChecksum) {
    return true;
  }
  if (currentChecksum === entry.expectedChecksum) {
    return true;
  }
  return false;
}
