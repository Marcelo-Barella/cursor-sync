import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import * as vscodeApi from "vscode";
import { computeChecksum } from "./packaging.js";
import { getLogger } from "./diagnostics.js";
import type { ResolvedSyncRoots } from "./app-config-sync-path-safety.js";
import {
  assertFinalPathMatchesHandle,
  assertParentDirHandleUnchanged,
  assertPathInodeSnapshotFresh,
  assertRealpathContainedInSyncRoot,
  capturePathInodeSnapshot,
  closeDirChain,
  HeldUnsafeWriteError,
  inodeOfHandle,
  inodeOfParentDirHandle,
  openFileNoFollow,
  openVerifiedDirChain,
  PathVerificationError,
  safeUnlinkTemp,
  unlinkPathIfInodeMatches,
  type InodeRef,
  type PathInodeSnapshot,
} from "./app-config-path-fd.js";
import {
  deletePullJournal,
  newJournalId,
  writePullJournal,
  type PullJournal,
  type PullJournalEntry,
} from "./app-config-pull-journal.js";
import {
  entryMatchesRemoteOrPrePull,
  expectedBackupDirForJournal,
  validatePullJournalForReplay,
} from "./app-config-journal-validate.js";
import { registerPullFinalize } from "./app-session-coordination.js";
import type { AppConfigsRunHandle } from "./app-session-coordination.js";
import { throwIfAppConfigsAborted } from "./app-session-coordination.js";

export interface PullWriteTarget {
  syncKey: string;
  absolutePath: string;
  content: Buffer;
  expectedChecksum: string;
}

export interface PullWriteResult {
  updated: number;
  failed: string[];
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

async function backupExistingSafe(
  backupDir: string,
  absolutePath: string,
  syncKey: string,
  index: number,
  resolved: ResolvedSyncRoots
): Promise<PullJournalEntry | undefined> {
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }
  const snapshot = await capturePathInodeSnapshot(absolutePath, syncKey, resolved);
  await assertPathInodeSnapshotFresh(snapshot);
  const existing = await readLinkOrFileChecksum(absolutePath);
  const backupPath = path.join(backupDir, backupNameFor(syncKey, index));
  if (existing.kind === "symlink" && existing.linkTarget !== undefined) {
    await fs.symlink(existing.linkTarget, backupPath);
  } else {
    const src = await openFileNoFollow(absolutePath, fsConstants.O_RDONLY);
    try {
      const data = await src.readFile();
      const dest = await fs.open(
        backupPath,
        fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
      );
      try {
        await dest.writeFile(data);
      } finally {
        await dest.close();
      }
    } finally {
      await src.close();
    }
    const mode = (await fs.lstat(absolutePath)).mode & 0o777;
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

async function writeUniqueTempInVerifiedParent(
  parentDirPath: string,
  snapshot: PathInodeSnapshot
): Promise<{ tmpPath: string; handle: Awaited<ReturnType<typeof openFileNoFollow>> }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.cursor-sync-pull-${randomBytes(16).toString("hex")}.tmp`;
    const tmpPath = path.join(parentDirPath, name);
    try {
      await assertPathInodeSnapshotFresh(snapshot);
      const handle = await fs.open(
        tmpPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW
      );
      return { tmpPath, handle };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not allocate unique temp file for pull write");
}

async function cleanupOrphanPullTemp(tmpPath: string | undefined): Promise<void> {
  if (!tmpPath) {
    return;
  }
  await safeUnlinkTemp(tmpPath);
}

async function recoverEscapedWrite(
  finalPath: string,
  writtenInode: InodeRef,
  tmpPath: string | undefined
): Promise<void> {
  await unlinkPathIfInodeMatches(finalPath, writtenInode);
  await cleanupOrphanPullTemp(tmpPath);
}

async function cleanupPullTempsAndEmptyDirs(entry: PullJournalEntry): Promise<void> {
  if (entry.tmpPath && (await pathExists(entry.tmpPath))) {
    try {
      const inode = await fs.lstat(entry.tmpPath);
      await fs.unlink(entry.tmpPath);
    } catch {
      // ignore
    }
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
  const validation = await validatePullJournalForReplay(context, journal);
  if (!validation.ok) {
    const { quarantinePullJournal } = await import("./app-config-pull-journal.js");
    await quarantinePullJournal(context, journal.id, validation.reason ?? "invalid journal");
    vscodeApi.window.showWarningMessage(
      `Cursor Sync refused to replay pull journal ${journal.id}: ${validation.reason ?? "validation failed"}. Backups were kept.`
    );
    return;
  }

  const { resolveSyncRoots } = await import("./paths.js");
  const { resolveSyncRootsRealpaths } = await import("./app-config-sync-path-safety.js");
  const resolved = await resolveSyncRootsRealpaths(resolveSyncRoots());

  for (const entry of [...journal.entries].reverse()) {
    try {
      const snapshot = await capturePathInodeSnapshot(
        entry.absolutePath,
        entry.syncKey,
        resolved
      );
      await assertPathInodeSnapshotFresh(snapshot);

      if (!entry.renameCompleted && entry.tmpPath) {
        await cleanupPullTempsAndEmptyDirs(entry);
      }
      if (entry.createdByPull) {
        if (await pathExists(entry.absolutePath)) {
          const current = await readLinkOrFileChecksum(entry.absolutePath);
          if (
            entry.wroteChecksum &&
            entryMatchesRemoteOrPrePull(entry, current.checksum)
          ) {
            await fs.rm(entry.absolutePath, { force: true });
          } else if (!entryMatchesRemoteOrPrePull(entry, current.checksum)) {
            logger.appendLine(
              `[${new Date().toISOString()}] Pull rollback kept user-edited created file ${entry.absolutePath}`
            );
          }
        }
        await cleanupPullTempsAndEmptyDirs(entry);
        continue;
      }
      if (!entry.backupPath) {
        continue;
      }
      const backupExpected = path.join(
        expectedBackupDirForJournal(context, journal.id),
        path.basename(entry.backupPath)
      );
      if (path.resolve(entry.backupPath) !== path.resolve(backupExpected)) {
        throw new PathVerificationError("backup path outside journal dir");
      }

      const onDisk = await pathExists(entry.absolutePath);
      if (onDisk) {
        const current = await readLinkOrFileChecksum(entry.absolutePath);
        if (!entryMatchesRemoteOrPrePull(entry, current.checksum)) {
          logger.appendLine(
            `[${new Date().toISOString()}] Pull rollback skipped user-edited file ${entry.absolutePath}`
          );
          vscodeApi.window.showWarningMessage(
            `Cursor Sync kept your changes to ${entry.syncKey} during pull restore.`
          );
          continue;
        }
      }
      if (entry.kind === "symlink" && entry.linkTarget !== undefined) {
        await fs.rm(entry.absolutePath, { force: true });
        await fs.symlink(entry.linkTarget, entry.absolutePath);
      } else if (entry.backupPath) {
        const src = await openFileNoFollow(entry.backupPath, fsConstants.O_RDONLY);
        try {
          const data = await src.readFile();
          await assertPathInodeSnapshotFresh(snapshot);
          const dest = await openFileNoFollow(
            entry.absolutePath,
            fsConstants.O_WRONLY | fsConstants.O_TRUNC
          );
          try {
            await dest.writeFile(data);
          } finally {
            await dest.close();
          }
        } finally {
          await src.close();
        }
        if (entry.priorMode !== undefined) {
          try {
            await fs.chmod(entry.absolutePath, entry.priorMode);
          } catch (err) {
            logger.appendLine(
              `[${new Date().toISOString()}] Pull rollback chmod skipped for ${entry.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.appendLine(
        `[${new Date().toISOString()}] Pull rollback failed for ${entry.absolutePath}: ${message}`
      );
      vscodeApi.window.showWarningMessage(
        `Cursor Sync could not fully restore ${entry.syncKey}: ${message}. The pull journal was kept.`
      );
    }
  }
}

export async function executeAppConfigPullWrites(
  context: vscode.ExtensionContext,
  run: AppConfigsRunHandle,
  targets: PullWriteTarget[],
  resolved: ResolvedSyncRoots
): Promise<PullWriteResult> {
  const failed: string[] = [];
  if (targets.length === 0) {
    return { updated: 0, failed };
  }

  const journalId = newJournalId();
  const backupDir = expectedBackupDirForJournal(context, journalId);
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

  let updated = 0;
  try {
    let index = 0;
    for (const target of targets) {
      throwIfAppConfigsAborted(run);
      let chain: Awaited<ReturnType<typeof openVerifiedDirChain>> | undefined;
      let orphanTmp: string | undefined;
      try {
        chain = await openVerifiedDirChain(target.absolutePath, target.syncKey, resolved);

        const backupEntry = await backupExistingSafe(
          backupDir,
          target.absolutePath,
          target.syncKey,
          index,
          resolved
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

        const createdDirs: string[] = [];
        if (!(await pathExists(chain.parentDirPath))) {
          await fs.mkdir(chain.parentDirPath, { recursive: true });
          createdDirs.push(chain.parentDirPath);
        }

        const parentInode = await inodeOfParentDirHandle(chain);

        const { tmpPath, handle: tmpHandle } = await writeUniqueTempInVerifiedParent(
          chain.parentDirPath,
          chain.snapshot
        );
        orphanTmp = tmpPath;
        let writtenInode: InodeRef | undefined;
        try {
          await tmpHandle.writeFile(target.content);
          await tmpHandle.sync();
          writtenInode = await inodeOfHandle(tmpHandle);
        } finally {
          await tmpHandle.close();
        }

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

        try {
          await assertPathInodeSnapshotFresh(chain.snapshot);
          await assertParentDirHandleUnchanged(chain, parentInode);
          await assertRealpathContainedInSyncRoot(
            target.absolutePath,
            target.syncKey,
            resolved
          );

          await fs.rename(tmpPath, target.absolutePath);

          await assertParentDirHandleUnchanged(chain, parentInode);
          await assertRealpathContainedInSyncRoot(
            target.absolutePath,
            target.syncKey,
            resolved
          );

          const finalHandle = await openFileNoFollow(
            target.absolutePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
          );
          try {
            await assertFinalPathMatchesHandle(finalHandle, target.absolutePath);
            if (writtenInode) {
              const finalInode = await inodeOfHandle(finalHandle);
              if (finalInode.dev !== writtenInode.dev || finalInode.ino !== writtenInode.ino) {
                throw new PathVerificationError(
                  `Post-rename file inode does not match written temp for ${target.absolutePath}`
                );
              }
            }
          } finally {
            await finalHandle.close();
          }
          if (priorMode !== undefined) {
            await fs.chmod(target.absolutePath, priorMode);
          }
          pendingEntry.renameCompleted = true;
          pendingEntry.tmpPath = undefined;
          orphanTmp = undefined;
          await writePullJournal(context, journal);
          updated += 1;
        } catch (postWriteErr) {
          if (writtenInode) {
            await recoverEscapedWrite(target.absolutePath, writtenInode, tmpPath);
          } else {
            await cleanupOrphanPullTemp(tmpPath);
          }
          orphanTmp = undefined;
          if (
            postWriteErr instanceof PathVerificationError ||
            postWriteErr instanceof HeldUnsafeWriteError
          ) {
            throw new HeldUnsafeWriteError(
              `Held/unsafe write for ${target.syncKey}: ${postWriteErr.message}`
            );
          }
          throw postWriteErr;
        }
      } catch (err) {
        if (orphanTmp) {
          await cleanupOrphanPullTemp(orphanTmp);
        }
        const reason =
          err instanceof HeldUnsafeWriteError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        failed.push(`${target.syncKey}: ${reason}`);
        if (err instanceof HeldUnsafeWriteError) {
          getLogger().appendLine(
            `[${new Date().toISOString()}] Pull held/unsafe write: ${target.syncKey}: ${reason}`
          );
        }
      } finally {
        if (chain) {
          await closeDirChain(chain);
        }
      }
    }

    if (failed.length > 0) {
      throw new Error(`Pull write failed for ${failed.length} file(s)`);
    }

    journal.phase = "complete";
    await writePullJournal(context, journal);
    await deletePullJournal(context, journal.id);
    return { updated, failed };
  } catch (err) {
    journal.phase = "rollback";
    await writePullJournal(context, journal);
    const finalize = rollbackPullJournal(context, journal);
    registerPullFinalize(finalize);
    let rollbackOk = true;
    try {
      await finalize;
    } catch {
      rollbackOk = false;
    }
    if (rollbackOk) {
      journal.phase = "complete";
      await writePullJournal(context, journal);
      await deletePullJournal(context, journal.id);
    }
    throw err;
  }
}
