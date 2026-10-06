import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { computeChecksum } from "./packaging.js";
import { getLogger } from "./diagnostics.js";
import type { ResolvedSyncRoots } from "./app-config-sync-path-safety.js";
import { assertContainedSyncPath } from "./app-config-sync-path-safety.js";
import {
  deletePullJournal,
  newJournalId,
  writePullJournal,
  type PullJournal,
  type PullJournalEntry,
} from "./app-config-pull-journal.js";
import { registerPullFinalize } from "./app-session-coordination.js";
import type { AppConfigsRunHandle } from "./app-session-coordination.js";
import { throwIfAppConfigsAborted } from "./app-session-coordination.js";

export interface PullWriteTarget {
  syncKey: string;
  absolutePath: string;
  content: Buffer;
  expectedChecksum: string;
}

function backupNameFor(syncKey: string, index: number): string {
  const hash = createHash("sha256").update(`${syncKey}:${index}`).digest("hex");
  return `${hash}.backup`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLinkOrFileChecksum(absolutePath: string): Promise<{
  kind: "file" | "symlink";
  checksum: string;
  linkTarget?: string;
}> {
  const st = await fs.lstat(absolutePath);
  if (st.isSymbolicLink()) {
    const linkTarget = await fs.readlink(absolutePath);
    const checksum = computeChecksum(Buffer.from(linkTarget, "utf-8"));
    return { kind: "symlink", checksum, linkTarget };
  }
  const buf = await fs.readFile(absolutePath);
  return { kind: "file", checksum: computeChecksum(buf) };
}

async function backupExisting(
  backupDir: string,
  absolutePath: string,
  syncKey: string,
  index: number
): Promise<PullJournalEntry | undefined> {
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }
  const existing = await readLinkOrFileChecksum(absolutePath);
  const backupPath = path.join(backupDir, backupNameFor(syncKey, index));
  if (existing.kind === "symlink" && existing.linkTarget !== undefined) {
    await fs.symlink(existing.linkTarget, backupPath);
  } else {
    await fs.copyFile(absolutePath, backupPath);
    const mode = (await fs.stat(absolutePath)).mode & 0o777;
    await fs.chmod(backupPath, mode);
  }
  return {
    syncKey,
    absolutePath,
    backupPath,
    createdByPull: false,
    expectedChecksum: existing.checksum,
    kind: existing.kind,
    linkTarget: existing.linkTarget,
  };
}

async function writeUniqueTemp(dir: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.cursor-sync-pull-${randomBytes(6).toString("hex")}.tmp`;
    const tmpPath = path.join(dir, name);
    try {
      const handle = await fs.open(
        tmpPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      );
      await handle.close();
      return tmpPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not allocate unique temp file for pull write");
}

async function assertEntryContained(
  entry: PullJournalEntry,
  resolved?: ResolvedSyncRoots
): Promise<void> {
  if (!resolved) {
    return;
  }
  await assertContainedSyncPath(entry.absolutePath, entry.syncKey, resolved);
  if (entry.backupPath) {
    const backupReal = await fs.realpath(entry.backupPath).catch(() => entry.backupPath!);
    const backupDirReal = await fs.realpath(path.dirname(entry.backupPath));
    if (!backupReal.startsWith(backupDirReal)) {
      throw new Error(`Refusing backup path outside backup dir: ${entry.backupPath}`);
    }
  }
}

async function cleanupPullTempsAndEmptyDirs(entry: PullJournalEntry): Promise<void> {
  if (entry.tmpPath && (await pathExists(entry.tmpPath))) {
    await fs.rm(entry.tmpPath, { force: true });
  }
  if (entry.createdDirs) {
    for (const dir of [...entry.createdDirs].reverse()) {
      try {
        const items = await fs.readdir(dir);
        if (items.length === 0) {
          await fs.rmdir(dir);
        }
      } catch {
        // ignore
      }
    }
  }
}

export async function rollbackPullJournal(
  context: vscode.ExtensionContext,
  journal: PullJournal
): Promise<void> {
  const logger = getLogger();
  const resolved = journal.resolvedRoots;
  for (const entry of [...journal.entries].reverse()) {
    try {
      await assertEntryContained(entry, resolved);
      if (!entry.renameCompleted && entry.tmpPath) {
        await cleanupPullTempsAndEmptyDirs(entry);
      }
      if (entry.createdByPull) {
        if (await pathExists(entry.absolutePath)) {
          const current = await readLinkOrFileChecksum(entry.absolutePath);
          if (entry.wroteChecksum && current.checksum === entry.wroteChecksum) {
            await fs.rm(entry.absolutePath, { force: true });
          }
        }
        await cleanupPullTempsAndEmptyDirs(entry);
        continue;
      }
      if (!entry.backupPath) {
        continue;
      }
      const onDisk = await pathExists(entry.absolutePath);
      if (onDisk && entry.wroteChecksum && entry.renameCompleted) {
        const current = await readLinkOrFileChecksum(entry.absolutePath);
        if (current.checksum !== entry.wroteChecksum) {
          logger.appendLine(
            `[${new Date().toISOString()}] Pull rollback skipped user-edited file ${entry.absolutePath}`
          );
          continue;
        }
      }
      if (entry.kind === "symlink" && entry.linkTarget !== undefined) {
        await fs.rm(entry.absolutePath, { force: true });
        await fs.symlink(entry.linkTarget, entry.absolutePath);
      } else if (entry.backupPath) {
        await fs.copyFile(entry.backupPath, entry.absolutePath);
        if (entry.priorMode !== undefined) {
          await fs.chmod(entry.absolutePath, entry.priorMode);
        }
      }
    } catch (err) {
      logger.appendLine(
        `[${new Date().toISOString()}] Pull rollback failed for ${entry.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export async function executeAppConfigPullWrites(
  context: vscode.ExtensionContext,
  run: AppConfigsRunHandle,
  targets: PullWriteTarget[],
  resolved: ResolvedSyncRoots
): Promise<boolean> {
  if (targets.length === 0) {
    return true;
  }

  const journalId = newJournalId();
  const backupDir = path.join(
    context.globalStorageUri.fsPath,
    "backups",
    `app-config-pull-${journalId}`
  );
  await fs.mkdir(backupDir, { recursive: true });

  const journal: PullJournal = {
    id: journalId,
    startedAt: new Date().toISOString(),
    backupDir,
    entries: [],
    phase: "writing",
    resolvedRoots: resolved,
  };
  await writePullJournal(context, journal);

  try {
    let index = 0;
    for (const target of targets) {
      throwIfAppConfigsAborted(run);
      await assertContainedSyncPath(target.absolutePath, target.syncKey, resolved);

      const backupEntry = await backupExisting(
        backupDir,
        target.absolutePath,
        target.syncKey,
        index
      );
      index += 1;

      const existedBefore = await pathExists(target.absolutePath);
      const createdByPull = !existedBefore;
      let priorMode: number | undefined;
      if (existedBefore) {
        const st = await fs.lstat(target.absolutePath);
        if (st.isFile()) {
          priorMode = st.mode & 0o777;
        }
      }

      const dir = path.dirname(target.absolutePath);
      const createdDirs: string[] = [];
      if (!(await pathExists(dir))) {
        await fs.mkdir(dir, { recursive: true });
        createdDirs.push(dir);
      }
      await assertContainedSyncPath(target.absolutePath, target.syncKey, resolved);

      const tmpPath = await writeUniqueTemp(dir);
      await fs.writeFile(tmpPath, target.content);
      const wroteChecksum = computeChecksum(target.content);

      const pendingEntry: PullJournalEntry = {
        syncKey: target.syncKey,
        absolutePath: target.absolutePath,
        backupPath: backupEntry?.backupPath,
        createdByPull,
        expectedChecksum: target.expectedChecksum,
        kind: backupEntry?.kind ?? "file",
        linkTarget: backupEntry?.linkTarget,
        wroteChecksum,
        tmpPath,
        renameCompleted: false,
        priorMode,
        createdDirs: createdDirs.length > 0 ? createdDirs : undefined,
      };
      journal.entries.push(pendingEntry);
      await writePullJournal(context, journal);

      await assertContainedSyncPath(target.absolutePath, target.syncKey, resolved);
      await fs.rename(tmpPath, target.absolutePath);
      if (priorMode !== undefined) {
        await fs.chmod(target.absolutePath, priorMode);
      }
      pendingEntry.renameCompleted = true;
      pendingEntry.tmpPath = undefined;
      await writePullJournal(context, journal);
    }

    journal.phase = "complete";
    await writePullJournal(context, journal);
    await deletePullJournal(context, journal.id);
    return true;
  } catch (err) {
    journal.phase = "rollback";
    await writePullJournal(context, journal);
    const finalize = rollbackPullJournal(context, journal);
    registerPullFinalize(finalize);
    await finalize;
    journal.phase = "complete";
    await writePullJournal(context, journal);
    await deletePullJournal(context, journal.id);
    throw err;
  }
}
