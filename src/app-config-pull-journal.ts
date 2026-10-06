import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";

export interface PullJournalEntry {
  syncKey: string;
  absolutePath: string;
  backupPath?: string;
  createdByPull: boolean;
  expectedChecksum: string;
  kind: "file" | "symlink";
  linkTarget?: string;
  wroteChecksum?: string;
}

export interface PullJournal {
  id: string;
  startedAt: string;
  backupDir: string;
  entries: PullJournalEntry[];
  phase: "writing" | "rollback" | "complete";
}

const JOURNALS_DIR = "app-config-pull-journals";

function journalsRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, JOURNALS_DIR);
}

export function newJournalId(): string {
  return randomBytes(8).toString("hex");
}

export async function writePullJournal(
  context: vscode.ExtensionContext,
  journal: PullJournal
): Promise<void> {
  const root = journalsRoot(context);
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${journal.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(journal, null, 2), "utf-8");
}

export async function deletePullJournal(
  context: vscode.ExtensionContext,
  journalId: string
): Promise<void> {
  try {
    await fs.unlink(path.join(journalsRoot(context), `${journalId}.json`));
  } catch {
    // ignore
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
    try {
      const raw = await fs.readFile(path.join(root, file), "utf-8");
      const parsed = JSON.parse(raw) as PullJournal;
      if (parsed.phase !== "complete") {
        journals.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return journals;
}

export async function collectJournalBackupDirs(
  context: vscode.ExtensionContext
): Promise<Set<string>> {
  const journals = await listIncompletePullJournals(context);
  return new Set(journals.map((j) => j.backupDir).filter(Boolean));
}

export async function replayIncompletePullJournals(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  const { rollbackPullJournal } = await import("./app-config-pull-files.js");
  const journals = await listIncompletePullJournals(context);
  for (const journal of journals) {
    logger.appendLine(
      `[${new Date().toISOString()}] Replaying incomplete app config pull journal ${journal.id}`
    );
    journal.phase = "rollback";
    await writePullJournal(context, journal);
    await rollbackPullJournal(context, journal);
    journal.phase = "complete";
    await writePullJournal(context, journal);
    await deletePullJournal(context, journal.id);
  }
}
