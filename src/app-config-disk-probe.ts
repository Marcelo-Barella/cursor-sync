import type * as vscode from "vscode";
import {
  classifyPathUnderSyncRoot,
  resolveSyncRootsRealpaths,
  symlinkedAncestorRelativePath,
  type ResolvedSyncRoots,
} from "./app-config-sync-path-safety.js";
import {
  getSyncEnumerationConfig,
  isSyncKeyExcludedByConfig,
  resolveSyncRoots,
  syncKeyToAbsolutePath,
} from "./paths.js";
import { nodePlatform } from "./os-runtime.js";
import { syncKeyRootPrefix } from "./app-config-sync-root-keys.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";

export type LocalPathClassification = "present" | "proven_absent" | "skipped_unknown";

export {
  assertSafeLocalDeleteTarget,
  assertSafePullTarget,
  ensureSyncRootDirectory,
  ensureSyncRootsForFreshPull,
  syncKeyUnderFailedRoot,
  mkdirParentsForSafePull,
  removeEmptyParentDirsWithinRoot,
  resolveSyncRootsRealpaths,
  syncRootRealForKey,
  writeFileWithoutFollow,
} from "./app-config-sync-path-safety.js";
export type { SyncRootEnsureFailure } from "./app-config-sync-path-safety.js";

export type LocalPathHeldHints = {
  excluded: boolean;
  oversize: boolean;
  symlink: boolean;
  underSymlinkDir?: string;
  unreadable: boolean;
};

async function readLocalPathHeldHints(
  context: vscode.ExtensionContext,
  syncKey: string,
  resolved: ResolvedSyncRoots,
  options?: { baselineLocalKeys?: string[] }
): Promise<LocalPathHeldHints> {
  const enumConfig = getSyncEnumerationConfig(context);
  const roots = resolveSyncRoots(nodePlatform(), context);
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  const hints: LocalPathHeldHints = {
    excluded: false,
    oversize: false,
    symlink: false,
    unreadable: false,
  };
  if (!absolutePath) {
    hints.unreadable = true;
    return hints;
  }

  hints.excluded = isSyncKeyExcludedByConfig(syncKey, enumConfig);
  const rel = syncKey.includes("/") ? syncKey.slice(syncKey.indexOf("/") + 1) : syncKey;
  const sizeLimit = rel.toLowerCase().endsWith(".vsix")
    ? 50 * 1024 * 1024
    : enumConfig.maxBytes;

  const fs = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  try {
    const st = await fs.lstat(absolutePath);
    if (st.isSymbolicLink()) {
      hints.symlink = true;
      return hints;
    }
    if (st.isFile()) {
      hints.oversize = st.size > sizeLimit;
      try {
        await fs.access(absolutePath, constants.R_OK);
      } catch {
        hints.unreadable = true;
      }
    } else if (!st.isDirectory()) {
      hints.unreadable = true;
    }
  } catch {
    /* missing path — proven_absent vs unreadable decided later */
  }

  const rootInfo = syncKey.startsWith("dot-cursor/")
    ? { rootPath: resolved.dotCursor }
    : syncKey.startsWith("cursor-user/")
      ? { rootPath: resolved.cursorUser }
      : undefined;
  if (rootInfo && !hints.symlink) {
    const ancestor = await symlinkedAncestorRelativePath(absolutePath, rootInfo.rootPath);
    if (ancestor) {
      hints.underSymlinkDir = ancestor;
    }
  }

  return hints;
}

export async function classifyLocalPath(
  context: vscode.ExtensionContext,
  syncKey: string,
  resolved?: ResolvedSyncRoots,
  options?: { baselineLocalKeys?: string[] }
): Promise<LocalPathClassification> {
  const roots = resolveSyncRoots(nodePlatform(), context);
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath) {
    return "skipped_unknown";
  }

  const resolvedRoots = resolved ?? await resolveSyncRootsRealpaths(roots);
  const hints = await readLocalPathHeldHints(context, syncKey, resolvedRoots, options);

  let isFilePresent = false;
  if (!hints.excluded && !hints.symlink && !hints.underSymlinkDir && !hints.unreadable) {
    try {
      const fs = await import("node:fs/promises");
      const st = await fs.lstat(absolutePath);
      isFilePresent = st.isFile() && !st.isSymbolicLink() && !hints.oversize;
    } catch {
      isFilePresent = false;
    }
  }

  return classifyPathUnderSyncRoot(absolutePath, syncKey, resolvedRoots, {
    excluded: hints.excluded,
    isFilePresent,
    fileOversize: hints.oversize,
    isUnreadable:
      hints.unreadable ||
      hints.symlink ||
      Boolean(hints.underSymlinkDir) ||
      hints.excluded ||
      hints.oversize,
    baselineLocalKeys: options?.baselineLocalKeys,
  });
}

function applyHeldHintsToScan(scan: LocalConfigFileScan, syncKey: string, hints: LocalPathHeldHints): void {
  if (hints.excluded) {
    if (!scan.excludedKeys) {
      scan.excludedKeys = new Set();
    }
    scan.excludedKeys.add(syncKey);
  }
  if (hints.oversize) {
    if (!scan.oversizeKeys) {
      scan.oversizeKeys = new Set();
    }
    scan.oversizeKeys.add(syncKey);
  }
  if (hints.symlink) {
    if (!scan.symlinkKeys) {
      scan.symlinkKeys = new Set();
    }
    scan.symlinkKeys.add(syncKey);
  }
  if (hints.underSymlinkDir) {
    if (!scan.underSymlinkedDirKeys) {
      scan.underSymlinkedDirKeys = new Set();
    }
    scan.underSymlinkedDirKeys.add(syncKey);
    if (!scan.symlinkedFolderLabels) {
      scan.symlinkedFolderLabels = {};
    }
    scan.symlinkedFolderLabels[syncKey] = hints.underSymlinkDir;
  }
}

export function applyLocalPathClassificationToScan(
  scan: LocalConfigFileScan,
  syncKey: string,
  classification: LocalPathClassification,
  hints?: LocalPathHeldHints
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

  if (hints) {
    applyHeldHintsToScan(scan, syncKey, hints);
  }

  const unreadableFallback =
    !hints ||
    (!hints.excluded &&
      !hints.oversize &&
      !hints.symlink &&
      !hints.underSymlinkDir &&
      hints.unreadable);

  scan.skippedUnknownKeys.add(syncKey);
  if (unreadableFallback) {
    scan.unreadableKeys.add(syncKey);
  } else {
    scan.unreadableKeys.delete(syncKey);
  }
  scan.provablyAbsentKeys.delete(syncKey);
  scan.absentEligibleKeys.delete(syncKey);
  scan.enoentKeys.delete(syncKey);
}

export async function scanWithDiskProbes(
  context: vscode.ExtensionContext,
  scan: LocalConfigFileScan,
  syncKeys: Iterable<string>,
  options?: { baselineLocalKeys?: string[] }
): Promise<LocalConfigFileScan> {
  const roots = resolveSyncRoots(nodePlatform(), context);
  const resolved = await resolveSyncRootsRealpaths(roots);
  const baselineLocalKeys = options?.baselineLocalKeys;
  const next: LocalConfigFileScan = {
    ...scan,
    unreadableKeys: new Set(scan.unreadableKeys),
    excludedKeys: new Set(scan.excludedKeys ?? []),
    oversizeKeys: new Set(scan.oversizeKeys ?? []),
    symlinkKeys: new Set(scan.symlinkKeys ?? []),
    underSymlinkedDirKeys: new Set(scan.underSymlinkedDirKeys ?? []),
    symlinkedFolderLabels: { ...(scan.symlinkedFolderLabels ?? {}) },
    enoentKeys: new Set(scan.enoentKeys),
    provablyAbsentKeys: new Set(scan.provablyAbsentKeys),
    skippedUnknownKeys: new Set(scan.skippedUnknownKeys),
    untrackedKeys: new Set(scan.untrackedKeys),
    absentEligibleKeys: new Set(scan.absentEligibleKeys),
    deleteBlockedRootPrefixes: new Set(scan.deleteBlockedRootPrefixes),
    checksums: { ...scan.checksums },
  };
  for (const key of syncKeys) {
    const prefix = syncKeyRootPrefix(key);
    if (prefix && scan.deleteBlockedRootPrefixes.has(prefix)) {
      applyLocalPathClassificationToScan(next, key, "skipped_unknown");
      continue;
    }
    const hints = await readLocalPathHeldHints(context, key, resolved, {
      baselineLocalKeys,
    });
    const classification = await classifyLocalPath(context, key, resolved, {
      baselineLocalKeys,
    });
    applyLocalPathClassificationToScan(next, key, classification, hints);
  }
  return next;
}
