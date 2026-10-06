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
 * 2. After `rename`, a race could leave bytes at a path that no longer matches the
 *    inode we wrote on the temp fd; post-rename `O_NOFOLLOW` open + dev/ino match
 *    and a second realpath containment check detect this; escaped files are unlinked
 *    only when `lstat` matches the written file's dev/ino.
 *
 * 3. `rename` itself is atomic on the same volume, but cannot be issued relative to
 *    an open parent directory fd in Node's API, so the parent inode can change identity
 *    if the directory is unlinked/replaced between our fstat and rename (detected by
 *    re-fstat on the held O_DIRECTORY handle).
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

export async function assertParentDirHandleUnchanged(
  chain: OpenDirChain,
  parentInode: InodeRef
): Promise<void> {
  const current = await inodeOfParentDirHandle(chain);
  assertInodesMatch(parentInode, current, "Parent directory");
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

export async function unlinkPathIfInodeMatches(
  absolutePath: string,
  expectedInode: InodeRef
): Promise<boolean> {
  try {
    const st = await fs.lstat(absolutePath);
    const current = { dev: st.dev, ino: st.ino };
    if (!inodesMatch(current, expectedInode)) {
      return false;
    }
    await fs.unlink(absolutePath);
    return true;
  } catch {
    return false;
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
