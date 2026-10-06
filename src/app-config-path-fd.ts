/**
 * Sync-root path operations with dev/ino verification.
 *
 * Residual TOCTOU window: between the final pre-rename lstat chain check and the
 * rename() syscall, a privileged attacker could still swap the destination name
 * in the verified parent directory. Node has no openat/renameat; this module
 * minimizes exposure by holding O_DIRECTORY handles and matching inodes before
 * and after rename.
 */
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedSyncRoots } from "./app-config-sync-path-safety.js";
import {
  assertContainedSyncPath,
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
