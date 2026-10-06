import type * as vscode from "vscode";
import {
  classifyPathUnderSyncRoot,
  resolveSyncRootsRealpaths,
  type ResolvedSyncRoots,
} from "./app-config-sync-path-safety.js";
import {
  getSyncEnumerationConfig,
  isSyncKeyExcludedByConfig,
  resolveSyncRoots,
  syncKeyToAbsolutePath,
} from "./paths.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";

export type LocalPathClassification = "present" | "proven_absent" | "skipped_unknown";

export {
  assertSafeLocalDeleteTarget,
  assertSafePullTarget,
  ensureSyncRootDirectory,
  ensureSyncRootsForFreshPull,
  mkdirParentsForSafePull,
  removeEmptyParentDirsWithinRoot,
  resolveSyncRootsRealpaths,
  syncRootRealForKey,
  writeFileWithoutFollow,
} from "./app-config-sync-path-safety.js";

export async function classifyLocalPath(
  context: vscode.ExtensionContext,
  syncKey: string,
  resolved?: ResolvedSyncRoots
): Promise<LocalPathClassification> {
  const enumConfig = getSyncEnumerationConfig(context);
  const roots = resolveSyncRoots(process.platform, context);
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath) {
    return "skipped_unknown";
  }

  const resolvedRoots = resolved ?? await resolveSyncRootsRealpaths(roots);
  const excluded = isSyncKeyExcludedByConfig(syncKey, enumConfig);
  const rel = syncKey.includes("/") ? syncKey.slice(syncKey.indexOf("/") + 1) : syncKey;
  const sizeLimit = rel.toLowerCase().endsWith(".vsix")
    ? 50 * 1024 * 1024
    : enumConfig.maxBytes;

  let isFilePresent = false;
  let fileOversize = false;
  try {
    const fs = await import("node:fs/promises");
    const st = await fs.lstat(absolutePath);
    if (st.isFile() && !st.isSymbolicLink()) {
      isFilePresent = true;
      fileOversize = st.size > sizeLimit;
    }
  } catch {
    isFilePresent = false;
  }

  return classifyPathUnderSyncRoot(absolutePath, syncKey, resolvedRoots, {
    excluded,
    isFilePresent,
    fileOversize,
  });
}

export function applyLocalPathClassificationToScan(
  scan: LocalConfigFileScan,
  syncKey: string,
  classification: LocalPathClassification
): void {
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
  const roots = resolveSyncRoots(process.platform, context);
  const resolved = await resolveSyncRootsRealpaths(roots);
  const next: LocalConfigFileScan = {
    ...scan,
    unreadableKeys: new Set(scan.unreadableKeys),
    enoentKeys: new Set(scan.enoentKeys),
    provablyAbsentKeys: new Set(scan.provablyAbsentKeys),
    skippedUnknownKeys: new Set(scan.skippedUnknownKeys),
    untrackedKeys: new Set(scan.untrackedKeys),
    absentEligibleKeys: new Set(scan.absentEligibleKeys),
    deleteBlockedRootPrefixes: new Set(scan.deleteBlockedRootPrefixes),
    checksums: { ...scan.checksums },
  };
  for (const key of syncKeys) {
    const classification = await classifyLocalPath(context, key, resolved);
    applyLocalPathClassificationToScan(next, key, classification);
  }
  return next;
}
