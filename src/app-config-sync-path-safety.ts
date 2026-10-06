import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type { SyncRoots } from "./paths.js";
import { syncKeyToAbsolutePath } from "./paths.js";
import {
  baselineHasKeysUnderPrefix,
  syncKeyRootPrefix,
} from "./app-config-sync-root-keys.js";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

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

export function isRealpathInsideRoot(
  childReal: string,
  rootReal: string
): boolean {
  const child = path.resolve(childReal);
  const root = path.resolve(rootReal);
  return child === root || child.startsWith(root + path.sep);
}

export async function ensureSyncRootDirectory(rootPath: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  try {
    const st = await fs.lstat(resolvedRoot);
    if (st.isSymbolicLink()) {
      const real = await fs.realpath(resolvedRoot);
      const realSt = await fs.stat(real);
      if (!realSt.isDirectory()) {
        throw new Error(`Sync root symlink does not resolve to a directory: ${resolvedRoot}`);
      }
      return;
    }
    if (!st.isDirectory()) {
      throw new Error(`Sync root is not a directory: ${resolvedRoot}`);
    }
    return;
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
  }
  const parent = path.dirname(resolvedRoot);
  const parentSt = await fs.lstat(parent);
  if (parentSt.isSymbolicLink() || !parentSt.isDirectory()) {
    throw new Error(`Cannot create sync root; parent is not a real directory: ${parent}`);
  }
  await fs.mkdir(resolvedRoot, { recursive: false });
}

export {
  baselineHasKeysForSyncKey,
  baselineHasKeysUnderPrefix,
  syncKeyRootPrefix,
} from "./app-config-sync-root-keys.js";

export type SyncRootEnsureFailure = {
  prefix: "cursor-user/" | "dot-cursor/";
  rootPath: string;
  message: string;
};

export async function ensureSyncRootsForFreshPull(
  roots: SyncRoots,
  syncKeysToWrite: string[],
  baselineLocalKeys: string[]
): Promise<SyncRootEnsureFailure[]> {
  const failures: SyncRootEnsureFailure[] = [];
  const needsUser = syncKeysToWrite.some((k) => k.startsWith("cursor-user/"));
  const needsDot = syncKeysToWrite.some((k) => k.startsWith("dot-cursor/"));
  const hasUserBaseline = baselineLocalKeys.some((k) => k.startsWith("cursor-user/"));
  const hasDotBaseline = baselineLocalKeys.some((k) => k.startsWith("dot-cursor/"));
  if (needsUser && !hasUserBaseline) {
    try {
      await ensureSyncRootDirectory(roots.cursorUser);
    } catch (err) {
      failures.push({
        prefix: "cursor-user/",
        rootPath: roots.cursorUser,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (needsDot && !hasDotBaseline) {
    try {
      await ensureSyncRootDirectory(roots.dotCursor);
    } catch (err) {
      failures.push({
        prefix: "dot-cursor/",
        rootPath: roots.dotCursor,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failures;
}

export function syncKeyUnderFailedRoot(
  syncKey: string,
  failures: SyncRootEnsureFailure[]
): SyncRootEnsureFailure | undefined {
  return failures.find((f) => syncKey.startsWith(f.prefix));
}

export async function pathHasUnsafeComponentBelowRoot(
  absolutePath: string,
  rootPath: string,
  rootReal: string
): Promise<boolean> {
  const normalized = path.resolve(absolutePath);
  const root = path.resolve(rootPath);
  if (normalized === root) {
    return false;
  }
  if (!normalized.startsWith(root + path.sep)) {
    return true;
  }

  let current = root;
  const rel = path.relative(root, normalized);
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        return true;
      }
      if (part !== parts[parts.length - 1] && !st.isDirectory()) {
        return true;
      }
    } catch (err) {
      if (isEnoent(err)) {
        return false;
      }
      return true;
    }
  }

  try {
    const fileReal = await fs.realpath(normalized).catch(() => normalized);
    if (!isRealpathInsideRoot(fileReal, rootReal)) {
      return true;
    }
  } catch {
    const parent = path.dirname(normalized);
    try {
      const parentReal = await fs.realpath(parent);
      if (!isRealpathInsideRoot(parentReal, rootReal)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export async function assertSafePullTarget(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<void> {
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new Error(`Unknown sync key root: ${syncKey}`);
  }
  if (
    await pathHasUnsafeComponentBelowRoot(
      absolutePath,
      rootInfo.rootPath,
      rootInfo.rootReal
    )
  ) {
    throw new Error(`Unsafe path (symlink or outside sync root): ${syncKey}`);
  }
  await mkdirParentsForSafePull(absolutePath, rootInfo.rootPath, rootInfo.rootReal);
  const parent = path.dirname(path.resolve(absolutePath));
  const parentReal = await fs.realpath(parent);
  if (!isRealpathInsideRoot(parentReal, rootInfo.rootReal)) {
    throw new Error(`Pull parent resolves outside sync root: ${syncKey}`);
  }
}

export async function mkdirParentsForSafePull(
  targetFilePath: string,
  rootPath: string,
  rootReal: string
): Promise<void> {
  const target = path.resolve(targetFilePath);
  const root = path.resolve(rootPath);
  if (!target.startsWith(root + path.sep)) {
    throw new Error("Target outside sync root");
  }
  const rel = path.relative(root, target);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length <= 1) {
    return;
  }
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    current = path.join(current, part);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to mkdir through symlink: ${current}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Path component is not a directory: ${current}`);
      }
      continue;
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
    await fs.mkdir(current);
    const afterReal = await fs.realpath(current);
    if (!isRealpathInsideRoot(afterReal, rootReal)) {
      throw new Error(`Created directory resolves outside sync root: ${current}`);
    }
  }
}

export async function writeFileWithoutFollow(
  absolutePath: string,
  content: Buffer,
  options?: { syncKey: string; resolved: ResolvedSyncRoots }
): Promise<void> {
  const target = path.resolve(absolutePath);
  const parent = path.dirname(target);
  const tmpName = `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = path.join(parent, tmpName);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let tmpOpened = false;
  try {
    if (options) {
      await assertSafePullTarget(target, options.syncKey, options.resolved);
    }
    handle = await fs.open(
      tmpPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW
    );
    tmpOpened = true;
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options) {
      await assertSafePullTarget(target, options.syncKey, options.resolved);
    }
    await fs.rename(tmpPath, target);
  } catch (err) {
    await handle?.close().catch(() => {});
    if (tmpOpened) {
      await fs.unlink(tmpPath).catch(() => {});
    }
    throw err;
  }
}

async function classifyAbsentUnderResolvedRoot(
  absolutePath: string,
  rootInfo: { rootPath: string; rootReal: string },
  baselineHasKeysUnderRoot: boolean
): Promise<"proven_absent" | "skipped_unknown"> {
  const logicalRoot = path.resolve(rootInfo.rootPath);
  const target = path.resolve(absolutePath);
  if (target !== logicalRoot && !target.startsWith(logicalRoot + path.sep)) {
    return "skipped_unknown";
  }

  let rootReal = path.resolve(rootInfo.rootReal);
  try {
    const rootSt = await fs.lstat(logicalRoot);
    if (rootSt.isSymbolicLink()) {
      rootReal = path.resolve(await fs.realpath(logicalRoot));
      const realSt = await fs.stat(rootReal);
      if (!realSt.isDirectory()) {
        return "skipped_unknown";
      }
    } else if (!rootSt.isDirectory()) {
      return "skipped_unknown";
    } else if (baselineHasKeysUnderRoot) {
      const entries = await fs.readdir(logicalRoot);
      if (entries.length === 0) {
        return "skipped_unknown";
      }
    }
  } catch (err) {
    if (isEnoent(err)) {
      return baselineHasKeysUnderRoot ? "skipped_unknown" : "proven_absent";
    }
    return "skipped_unknown";
  }

  const rel = path.relative(logicalRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return "skipped_unknown";
  }
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length === 0) {
    return "skipped_unknown";
  }

  let currentReal = rootReal;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const isLeaf = i === parts.length - 1;
    currentReal = path.join(currentReal, part);
    try {
      const st = await fs.lstat(currentReal);
      if (st.isSymbolicLink()) {
        return "skipped_unknown";
      }
      if (isLeaf) {
        return "skipped_unknown";
      }
      if (!st.isDirectory()) {
        return "skipped_unknown";
      }
      if (!isRealpathInsideRoot(path.resolve(currentReal), rootReal)) {
        return "skipped_unknown";
      }
    } catch (err) {
      if (!isEnoent(err)) {
        return "skipped_unknown";
      }
      return "proven_absent";
    }
  }
  return "skipped_unknown";
}

export async function assertSafeLocalDeleteTarget(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots
): Promise<void> {
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo) {
    throw new Error(`Unknown sync key root: ${syncKey}`);
  }
  if (
    await pathHasUnsafeComponentBelowRoot(
      absolutePath,
      rootInfo.rootPath,
      rootInfo.rootReal
    )
  ) {
    throw new Error(`Unsafe delete path: ${syncKey}`);
  }
  const st = await fs.lstat(absolutePath);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to delete through symlink: ${syncKey}`);
  }
  const fileReal = await fs.realpath(absolutePath);
  if (!isRealpathInsideRoot(fileReal, rootInfo.rootReal)) {
    throw new Error(`Delete path resolves outside sync root: ${syncKey}`);
  }
}

export async function removeEmptyParentDirsWithinRoot(
  filePath: string,
  rootPath: string,
  rootReal: string
): Promise<void> {
  const root = path.resolve(rootPath);
  let dir = path.dirname(path.resolve(filePath));
  while (dir.length >= root.length && (dir === root || dir.startsWith(root + path.sep))) {
    if (dir === root) {
      break;
    }
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink()) {
        break;
      }
      if (!st.isDirectory()) {
        break;
      }
      const entries = await fs.readdir(dir);
      if (entries.length > 0) {
        break;
      }
      const dirReal = await fs.realpath(dir);
      if (!isRealpathInsideRoot(dirReal, rootReal)) {
        break;
      }
      await fs.rmdir(dir);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

export async function classifyPathUnderSyncRoot(
  absolutePath: string,
  syncKey: string,
  resolved: ResolvedSyncRoots,
  options: {
    excluded: boolean;
    isFilePresent: boolean;
    fileOversize: boolean;
    isUnreadable?: boolean;
    baselineLocalKeys?: string[];
  }
): Promise<"present" | "proven_absent" | "skipped_unknown"> {
  const prefix = syncKeyRootPrefix(syncKey);
  const baselineHasKeysUnderRoot =
    prefix !== undefined &&
    baselineHasKeysUnderPrefix(prefix, options.baselineLocalKeys);
  const rootInfo = syncRootRealForKey(syncKey, resolved);
  if (!rootInfo || options.excluded) {
    return "skipped_unknown";
  }

  if (options.isUnreadable) {
    return "skipped_unknown";
  }

  if (
    await pathHasUnsafeComponentBelowRoot(
      absolutePath,
      rootInfo.rootPath,
      rootInfo.rootReal
    )
  ) {
    return "skipped_unknown";
  }

  if (options.isFilePresent) {
    if (options.fileOversize) {
      return "skipped_unknown";
    }
    try {
      const st = await fs.lstat(absolutePath);
      if (!st.isFile() || st.isSymbolicLink()) {
        return "skipped_unknown";
      }
      const fileReal = await fs.realpath(absolutePath);
      if (!isRealpathInsideRoot(fileReal, rootInfo.rootReal)) {
        return "skipped_unknown";
      }
      return "present";
    } catch {
      return "skipped_unknown";
    }
  }

  try {
    await fs.lstat(absolutePath);
    return "skipped_unknown";
  } catch (err) {
    if (!isEnoent(err)) {
      return "skipped_unknown";
    }
  }

  return classifyAbsentUnderResolvedRoot(
    absolutePath,
    rootInfo,
    baselineHasKeysUnderRoot
  );
}
