import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncRoots } from "./paths.js";

export interface ResolvedSyncRoots {
  cursorUser: string;
  dotCursor: string;
  cursorUserReal: string;
  dotCursorReal: string;
}

export async function resolveSyncRootsRealpaths(
  roots: SyncRoots
): Promise<ResolvedSyncRoots> {
  const cursorUserReal = await fs.realpath(roots.cursorUser).catch(() =>
    path.resolve(roots.cursorUser)
  );
  const dotCursorReal = await fs.realpath(roots.dotCursor).catch(() =>
    path.resolve(roots.dotCursor)
  );
  return {
    cursorUser: roots.cursorUser,
    dotCursor: roots.dotCursor,
    cursorUserReal,
    dotCursorReal,
  };
}

export function syncRootRealForKey(
  syncKey: string,
  resolved: ResolvedSyncRoots
): { rootPath: string; rootReal: string } | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    return { rootPath: resolved.cursorUser, rootReal: resolved.cursorUserReal };
  }
  if (syncKey.startsWith("dot-cursor/")) {
    return { rootPath: resolved.dotCursor, rootReal: resolved.dotCursorReal };
  }
  return undefined;
}

export function isRealpathInsideRoot(childReal: string, rootReal: string): boolean {
  const child = path.resolve(childReal);
  const root = path.resolve(rootReal);
  return child === root || child.startsWith(root + path.sep);
}

async function resolvePathWithinSyncRoot(
  absolutePath: string,
  rootPath: string,
  rootReal: string
): Promise<string> {
  const normalized = path.resolve(absolutePath);
  const rootResolved = path.resolve(rootPath);
  const relative = path.relative(rootResolved, normalized);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside sync root: ${absolutePath}`);
  }
  if (relative === "") {
    return rootReal;
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let currentReal = rootReal;
  for (const segment of segments) {
    const next = path.join(currentReal, segment);
    currentReal = await fs.realpath(next).catch(async () => {
      const parentReal = await fs.realpath(path.dirname(next)).catch(() => path.dirname(next));
      if (!isRealpathInsideRoot(parentReal, rootReal)) {
        throw new Error(`Refusing path outside sync root: ${absolutePath}`);
      }
      const joined = path.join(parentReal, path.basename(next));
      if (!isRealpathInsideRoot(joined, rootReal)) {
        throw new Error(`Refusing path outside sync root: ${absolutePath}`);
      }
      return joined;
    });
    if (!isRealpathInsideRoot(currentReal, rootReal)) {
      throw new Error(`Refusing path outside sync root: ${absolutePath}`);
    }
  }
  return currentReal;
}

export async function assertContainedSyncPath(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<void> {
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new Error(`Unsupported sync key: ${syncKey}`);
  }
  await resolvePathWithinSyncRoot(absolutePath, rootInfo.rootPath, rootInfo.rootReal);
}
