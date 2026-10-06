import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  getSyncEnumerationConfig,
  isSyncKeyExcludedByConfig,
  resolveSyncRoots,
  syncKeyToAbsolutePath,
} from "./paths.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";

export type LocalPathClassification = "present" | "proven_absent" | "skipped_unknown";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function absolutePathUnderEnabledRoot(
  absolutePath: string,
  roots: ReturnType<typeof resolveSyncRoots>
): boolean {
  const normalized = path.resolve(absolutePath);
  const prefixes = [roots.cursorUser, roots.dotCursor].map((p) =>
    path.resolve(p)
  );
  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + path.sep)
  );
}

async function directoryIsReadableRealDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return false;
    }
    await fs.readdir(dir);
    return true;
  } catch {
    return false;
  }
}

async function provenAbsentViaAncestorWalk(
  absolutePath: string,
  roots: ReturnType<typeof resolveSyncRoots>
): Promise<boolean> {
  let dir = path.dirname(absolutePath);
  for (;;) {
    if (!absolutePathUnderEnabledRoot(dir, roots)) {
      return false;
    }
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink()) {
        return false;
      }
      if (st.isDirectory()) {
        return await directoryIsReadableRealDir(dir);
      }
      return false;
    } catch (err) {
      if (!isEnoent(err)) {
        return false;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return false;
      }
      dir = parent;
    }
  }
}

export async function classifyLocalPath(
  context: vscode.ExtensionContext,
  syncKey: string
): Promise<LocalPathClassification> {
  const enumConfig = getSyncEnumerationConfig(context);
  const roots = resolveSyncRoots(process.platform, context);
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath || !absolutePathUnderEnabledRoot(absolutePath, roots)) {
    return "skipped_unknown";
  }

  if (isSyncKeyExcludedByConfig(syncKey, enumConfig)) {
    return "skipped_unknown";
  }

  try {
    const st = await fs.lstat(absolutePath);
    if (st.isSymbolicLink()) {
      return "skipped_unknown";
    }
    if (!st.isFile()) {
      return "skipped_unknown";
    }
    const rel = syncKey.includes("/") ? syncKey.slice(syncKey.indexOf("/") + 1) : syncKey;
    const sizeLimit = rel.toLowerCase().endsWith(".vsix")
      ? 50 * 1024 * 1024
      : enumConfig.maxBytes;
    if (st.size > sizeLimit) {
      return "skipped_unknown";
    }
    return "present";
  } catch (err) {
    if (!isEnoent(err)) {
      return "skipped_unknown";
    }
    if (await provenAbsentViaAncestorWalk(absolutePath, roots)) {
      return "proven_absent";
    }
    return "skipped_unknown";
  }
}

export function applyLocalPathClassificationToScan(
  scan: LocalConfigFileScan,
  syncKey: string,
  classification: LocalPathClassification
): void {
  if (
    scan.provablyAbsentKeys.has(syncKey) &&
    classification !== "present"
  ) {
    scan.skippedUnknownKeys.delete(syncKey);
    scan.unreadableKeys.delete(syncKey);
    scan.absentEligibleKeys.add(syncKey);
    scan.enoentKeys.add(syncKey);
    return;
  }

  scan.untrackedKeys.delete(syncKey);

  if (classification === "present") {
    scan.skippedUnknownKeys.delete(syncKey);
    scan.unreadableKeys.delete(syncKey);
    scan.provablyAbsentKeys.delete(syncKey);
    scan.absentEligibleKeys.delete(syncKey);
    scan.enoentKeys.delete(syncKey);
    return;
  }

  if (classification === "proven_absent") {
    scan.skippedUnknownKeys.delete(syncKey);
    scan.unreadableKeys.delete(syncKey);
    scan.provablyAbsentKeys.add(syncKey);
    scan.absentEligibleKeys.add(syncKey);
    scan.enoentKeys.add(syncKey);
    return;
  }

  scan.skippedUnknownKeys.add(syncKey);
  scan.unreadableKeys.add(syncKey);
  scan.provablyAbsentKeys.delete(syncKey);
  scan.absentEligibleKeys.delete(syncKey);
  scan.enoentKeys.delete(syncKey);
}

export async function scanWithDiskProbes(
  context: vscode.ExtensionContext,
  scan: LocalConfigFileScan,
  syncKeys: Iterable<string>
): Promise<LocalConfigFileScan> {
  const next: LocalConfigFileScan = {
    ...scan,
    unreadableKeys: new Set(scan.unreadableKeys),
    enoentKeys: new Set(scan.enoentKeys),
    provablyAbsentKeys: new Set(scan.provablyAbsentKeys),
    skippedUnknownKeys: new Set(scan.skippedUnknownKeys),
    untrackedKeys: new Set(scan.untrackedKeys),
    absentEligibleKeys: new Set(scan.absentEligibleKeys),
    checksums: { ...scan.checksums },
  };
  for (const key of syncKeys) {
    const classification = await classifyLocalPath(context, key);
    applyLocalPathClassificationToScan(next, key, classification);
  }
  return next;
}

export async function mkdirParentsWithoutSymlinks(targetFilePath: string): Promise<void> {
  const targetDir = path.dirname(path.resolve(targetFilePath));
  const toCreate: string[] = [];
  let current = targetDir;
  for (;;) {
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to create path through symlink: ${current}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`Path component is not a directory: ${current}`);
      }
      break;
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
      toCreate.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  for (const dir of toCreate) {
    await fs.mkdir(dir);
  }
}
