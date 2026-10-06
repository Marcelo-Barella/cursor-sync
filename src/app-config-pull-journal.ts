import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import * as vscodeApi from "vscode";
import { getLogger } from "./diagnostics.js";
import type { ResolvedSyncRoots } from "./app-config-sync-path-safety.js";

export interface PullJournalEntry {
  syncKey: string;
  absolutePath: string;
  backupPath?: string;
  createdByPull: boolean;
  expectedChecksum: string;
  kind: "file" | "symlink";
  linkTarget?: string;
  wroteChecksum?: string;
  tmpPath?: string;
  renameCompleted?: boolean;
  priorMode?: number;
  createdDirs?: string[];
}

export interface PullJournal {
  id: string;
  startedAt: string;
  backupDir: string;
  entries: PullJournalEntry[];
  phase: "writing" | "rollback" | "complete";
  resolvedRoots?: ResolvedSyncRoots;
}

const JOURNALS_DIR = "app-config-pull-journals";

const corruptJournalIds = new Set<string>();

export function getCorruptPullJournalIds(): ReadonlySet<string> {
  return corruptJournalIds;
}

function journalsRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, JOURNALS_DIR);
}

export function newJournalId(): string {
  return randomBytes(8).toString("hex");
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const handle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePullJournal(
  context: vscode.ExtensionContext,
  journal: PullJournal
): Promise<void> {
  const root = journalsRoot(context);
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${journal.id}.json`);
  const tmpPath = path.join(root, `${journal.id}.${randomBytes(4).toString("hex")}.tmp`);
  const payload = JSON.stringify(journal, null, 2);
  await fs.writeFile(tmpPath, payload, "utf-8");
  await fsyncFile(tmpPath);
  await fs.rename(tmpPath, filePath);
  await fsyncParentDir(filePath);
}

export async function deletePullJournal(
  context: vscode.ExtensionContext,
  journalId: string
): Promise<void> {
  if (corruptJournalIds.has(journalId)) {
    return;
  }
  try {
    await fs.unlink(path.join(journalsRoot(context), `${journalId}.json`));
  } catch {
    // ignore
  }
}

async function readJournalFile(
  context: vscode.ExtensionContext,
  fileName: string
): Promise<PullJournal | "corrupt" | undefined> {
  const filePath = path.join(journalsRoot(context), fileName);
  try {
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink()) {
      return "corrupt";
    }
  } catch {
    return undefined;
  }
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PullJournal;
    if (!parsed.id || !parsed.backupDir) {
      return "corrupt";
    }
    return parsed;
  } catch {
    return "corrupt";
  }
}

export async function listIncompletePullJournals(
  context: vscode.ExtensionContext
): Promise<PullJournal[]> {
  const root = journalsRoot(context);
  let files: string[];
  try {
    files = await fs.readdir(root);
  } catch {
    return [];
  }
  const journals: PullJournal[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const journalId = file.replace(/\.json$/, "");
    const parsed = await readJournalFile(context, file);
    if (parsed === "corrupt") {
      corruptJournalIds.add(journalId);
      continue;
    }
    if (!parsed) {
      continue;
    }
    if (parsed.phase !== "complete") {
      journals.push(parsed);
    }
  }
  return journals;
}

export async function collectJournalBackupDirs(
  context: vscode.ExtensionContext
): Promise<Set<string>> {
  const journals = await listIncompletePullJournals(context);
  const dirs = new Set(journals.map((j) => j.backupDir).filter(Boolean));
  for (const id of corruptJournalIds) {
    const parsed = await readJournalFile(context, `${id}.json`);
    if (parsed && parsed !== "corrupt" && parsed.backupDir) {
      dirs.add(parsed.backupDir);
    }
  }
  return dirs;
}

export async function warnCorruptPullJournals(context: vscode.ExtensionContext): Promise<void> {
  if (corruptJournalIds.size === 0) {
    return;
  }
  vscodeApi.window.showWarningMessage(
    "Cursor Sync found a damaged app-config pull journal. Backups were kept; restart may retry restore."
  );
}

export async function replayIncompletePullJournals(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const { rollbackPullJournal } = await import("./app-config-pull-files.js");
  await warnCorruptPullJournals(context);
  const journals = await listIncompletePullJournals(context);
  for (const journal of journals) {
    logger.appendLine(
      `[${new Date().toISOString()}] Replaying incomplete app config pull journal ${journal.id}`
    );
    try {
      await fs.access(journal.backupDir);
    } catch {
      vscodeApi.window.showWarningMessage(
        `Cursor Sync could not restore app config pull ${journal.id}: backup folder is missing.`
      );
      continue;
    }
    journal.phase = "rollback";
    await writePullJournal(context, journal);
    await rollbackPullJournal(context, journal);
    journal.phase = "complete";
    await writePullJournal(context, journal);
    await deletePullJournal(context, journal.id);
  }
}
