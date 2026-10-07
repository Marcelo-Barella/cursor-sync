/**
 * Sync-root path operations with dev/ino verification.
 *
 * Residual TOCTOU window (Node fs/promises only):
 *
 * 1. Between the last pre-rename checks (parent dev/ino, path snapshot, realpath
 *    containment) and `rename(tmp, final)`, a privileged attacker could replace
 *    the destination name or repoint a directory entry in the verified parent.
 *    We do not hold the destination open across rename because the final path may
 *    not exist yet; there is no `renameat` bound to our parent fd.
 *
 * 2. Temp files are still opened by path string (`fs.open(tmpPath, …)`); a parent
 *    directory swap between our snapshot and that open is not fully closed in Node
 *    (no `openat`). We re-open the parent by path after `rename` and compare dev/ino
 *    to the pre-write snapshot.
 *
 * 3. After `rename`, post-rename `O_NOFOLLOW` open + dev/ino match and realpath
 *    containment detect a swapped destination; escaped-byte cleanup unlinks only when
 *    an `O_NOFOLLOW` open proves the path still refers to the inode we wrote (never
 *    `lstat`+`unlink` alone).
 *
 * 4. `rename` is atomic on one volume but is not issued relative to a held parent fd.
 *
 * Temp files use `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` with unpredictable names inside
 * the verified parent; final verification uses `O_RDONLY|O_NOFOLLOW` after rename.
 */
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedSyncRoots } from "./app-config-sync-path-safety.js";
import {
  assertContainedSyncPath,
  isRealpathInsideRoot,
  syncRootRealForKey,
} from "./app-config-sync-path-safety.js";

export interface InodeRef {
  dev: number;
  ino: number;
}

export interface PathInodeSnapshot {
  absolutePath: string;
  syncKey: string;
  segments: Array<{ segmentPath: string; inode: InodeRef }>;
}

export class PathVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathVerificationError";
  }
}

async function lstatInode(filePath: string): Promise<InodeRef> {
  const st = await fs.lstat(filePath);
  return { dev: st.dev, ino: st.ino };
}

function inodesMatch(a: InodeRef, b: InodeRef): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export async function capturePathInodeSnapshot(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<PathInodeSnapshot> {
  await assertContainedSyncPath(absolutePath, syncKey, resolved);
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new PathVerificationError(`Unsupported sync key: ${syncKey}`);
  }
  const normalized = path.resolve(absolutePath);
  const relative = path.relative(path.resolve(rootInfo.rootPath), normalized);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathVerificationError(`Refusing path outside sync root: ${absolutePath}`);
  }
  const segments: PathInodeSnapshot["segments"] = [];
  let current = path.resolve(rootInfo.rootPath);
  segments.push({ segmentPath: current, inode: await lstatInode(current) });
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      segments.push({ segmentPath: current, inode: await lstatInode(current) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && part === parts[parts.length - 1]) {
        break;
      }
      throw err;
    }
  }
  return { absolutePath: normalized, syncKey, segments };
}

export async function assertPathInodeSnapshotFresh(snapshot: PathInodeSnapshot): Promise<void> {
  for (const segment of snapshot.segments) {
    const current = await lstatInode(segment.segmentPath);
    if (!inodesMatch(current, segment.inode)) {
      throw new PathVerificationError(
        `Path changed during pull (TOCTOU): ${segment.segmentPath}`
      );
    }
  }
}

export interface OpenDirChain {
  rootPath: string;
  dirHandles: FileHandle[];
  parentDirPath: string;
  snapshot: PathInodeSnapshot;
}

/**
 * Create missing intermediate parent directories under a verified sync-root ancestor.
 * Walks one segment at a time (no recursive mkdir on the full path). Refuses symlinks.
 */
export async function ensureVerifiedIntermediateParents(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<string[]> {
  await assertContainedSyncPath(absolutePath, syncKey, resolved);
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new PathVerificationError(`Unsupported sync key: ${syncKey}`);
  }

  const normalized = path.resolve(absolutePath);
  const parentDirPath = path.dirname(normalized);
  const rootResolved = path.resolve(rootInfo.rootPath);
  const relative = path.relative(rootResolved, parentDirPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathVerificationError(`Refusing path outside sync root: ${absolutePath}`);
  }
  if (relative === "") {
    return [];
  }

  const created: string[] = [];
  const parts = relative.split(path.sep).filter(Boolean);
  let current = rootResolved;

  for (const part of parts) {
    const next = path.join(current, part);
    try {
      const st = await fs.lstat(next);
      if (st.isSymbolicLink()) {
        throw new PathVerificationError(`Refusing symlink in pull parent path: ${next}`);
      }
      if (!st.isDirectory()) {
        throw new PathVerificationError(`Refusing non-directory in pull parent path: ${next}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(next);
        created.push(next);
      } else {
        throw err;
      }
    }
    await assertRealpathContainedInSyncRoot(next, syncKey, resolved);
    current = next;
  }

  return created;
}

export async function openVerifiedDirChain(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<OpenDirChain> {
  const snapshot = await capturePathInodeSnapshot(absolutePath, syncKey, resolved);
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new PathVerificationError(`Unsupported sync key: ${syncKey}`);
  }
  const normalized = path.resolve(absolutePath);
  const parentDirPath = path.dirname(normalized);
  const relative = path.relative(path.resolve(rootInfo.rootPath), parentDirPath);
  const parts = relative === "" ? [] : relative.split(path.sep).filter(Boolean);

  const dirHandles: FileHandle[] = [];
  let current = path.resolve(rootInfo.rootPath);
  const rootHandle = await fs.open(
    current,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  );
  dirHandles.push(rootHandle);

  for (const part of parts) {
    await assertPathInodeSnapshotFresh(snapshot);
    current = path.join(current, part);
    const handle = await fs.open(
      current,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    dirHandles.push(handle);
  }

  return { rootPath: rootInfo.rootPath, dirHandles, parentDirPath, snapshot };
}

export async function closeDirChain(chain: OpenDirChain): Promise<void> {
  for (const handle of [...chain.dirHandles].reverse()) {
    await handle.close();
  }
}

export async function openFileNoFollow(filePath: string, flags: number): Promise<FileHandle> {
  return fs.open(filePath, flags | fsConstants.O_NOFOLLOW);
}

export async function inodeOfHandle(handle: FileHandle): Promise<InodeRef> {
  const st = await handle.stat();
  return { dev: st.dev, ino: st.ino };
}

export async function assertFinalPathMatchesHandle(
  handle: FileHandle,
  finalPath: string
): Promise<void> {
  const fromHandle = await inodeOfHandle(handle);
  const fromPath = await lstatInode(finalPath);
  if (!inodesMatch(fromHandle, fromPath)) {
    throw new PathVerificationError(`Post-rename inode mismatch for ${finalPath}`);
  }
}

export function assertInodesMatch(expected: InodeRef, actual: InodeRef, label: string): void {
  if (!inodesMatch(expected, actual)) {
    throw new PathVerificationError(`${label} inode changed (dev/ino mismatch)`);
  }
}

export async function inodeOfParentDirHandle(chain: OpenDirChain): Promise<InodeRef> {
  const parentHandle = chain.dirHandles[chain.dirHandles.length - 1];
  if (!parentHandle) {
    throw new PathVerificationError("Missing parent directory handle");
  }
  return inodeOfHandle(parentHandle);
}

export async function assertParentDirInodeUnchangedByPath(
  parentDirPath: string,
  expectedInode: InodeRef
): Promise<void> {
  const handle = await fs.open(
    parentDirPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  );
  try {
    const current = await inodeOfHandle(handle);
    assertInodesMatch(expectedInode, current, "Parent directory");
  } finally {
    await handle.close();
  }
}

export async function assertRealpathContainedInSyncRoot(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<void> {
  await assertContainedSyncPath(absolutePath, syncKey, resolved);
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new PathVerificationError(`Unsupported sync key: ${syncKey}`);
  }
  const targetReal = await fs.realpath(absolutePath).catch(() => path.resolve(absolutePath));
  if (!isRealpathInsideRoot(targetReal, rootInfo.rootReal)) {
    throw new PathVerificationError(`Path escaped sync root after verification: ${absolutePath}`);
  }
}

export class HeldUnsafeWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeldUnsafeWriteError";
  }
}

/**
 * Unlink only when an O_NOFOLLOW open proves the path still refers to expectedInode.
 * Returns true if unlinked, false if the path is a different file or cannot be proven.
 */
export async function unlinkWrittenFileIfProvenByOpen(
  absolutePath: string,
  expectedInode: InodeRef
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFileNoFollow(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    const fromHandle = await inodeOfHandle(handle);
    if (!inodesMatch(fromHandle, expectedInode)) {
      return false;
    }
    const fromPath = await lstatInode(absolutePath);
    if (!inodesMatch(fromHandle, fromPath)) {
      return false;
    }
    await handle.close();
    handle = undefined;
    await fs.unlink(absolutePath);
    return true;
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export async function safeUnlinkTemp(tmpPath: string): Promise<void> {
  try {
    await fs.unlink(tmpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // ignore other cleanup failures
    }
  }
}
