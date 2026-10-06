import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { computeChecksum } from "./packaging.js";
import {
  enumerateSyncFiles,
  getSyncEnumerationConfig,
  isSyncKeyExcludedByConfig,
  resolveSyncRoots,
  syncKeyToAbsolutePath,
  type SyncRoots,
} from "./paths.js";
import type { AppStorageBaseline } from "./app-storage-baseline.js";
import { GENERATED_EXTENSIONS_SYNC_KEY } from "./app-config-extensions-align.js";
import {
  classifyLocalPath,
  resolveSyncRootsRealpaths,
} from "./app-config-disk-probe.js";
import { pathHasUnsafeComponentBelowRoot } from "./app-config-sync-path-safety.js";
import { nodePlatform } from "./os-runtime.js";

export type BaselineKeyPresence = "present" | "provably_absent" | "skipped_unknown";

export interface LocalConfigFileScan {
  checksums: Record<string, string>;
  /** @deprecated use skippedUnknownKeys */
  unreadableKeys: Set<string>;
  /** Tracked keys excluded by sync profile globs */
  excludedKeys?: Set<string>;
  /** Tracked keys over max file size */
  oversizeKeys?: Set<string>;
  /** Local path is a symlink (or non-file) */
  symlinkKeys?: Set<string>;
  /** File lies under a symlinked directory (file itself is not a symlink) */
  underSymlinkedDirKeys?: Set<string>;
  /** Label for underSymlinkedDirKeys entries (relative symlink dir path) */
  symlinkedFolderLabels?: Record<string, string>;
  enoentKeys: Set<string>;
  provablyAbsentKeys: Set<string>;
  skippedUnknownKeys: Set<string>;
  untrackedKeys: Set<string>;
  absentEligibleKeys: Set<string>;
  deletesAllowed: boolean;
  deleteBlockReason?: string;
  enumeratedCount: number;
  rootsHealthy: boolean;
  trackingScopeMismatch: boolean;
  deleteBlockedRootPrefixes: Set<string>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function trackingScopeMatches(
  baseline: AppStorageBaseline | undefined,
  current: ReturnType<typeof getSyncEnumerationConfig>
): boolean {
  const saved = baseline?.trackingScope;
  if (!saved) {
    return true;
  }
  return (
    JSON.stringify(saved.enabledPaths) === JSON.stringify(current.enabledPaths) &&
    JSON.stringify(saved.excludeGlobs) === JSON.stringify(current.excludeGlobs) &&
    saved.maxFileSizeKB === current.maxFileSizeKB
  );
}

export function buildTrackingScopeForBaseline(
  context: vscode.ExtensionContext
): AppStorageBaseline["trackingScope"] {
  const cfg = getSyncEnumerationConfig(context);
  return {
    enabledPaths: [...cfg.enabledPaths],
    excludeGlobs: [...cfg.excludeGlobs],
    maxFileSizeKB: cfg.maxFileSizeKB,
  };
}

type RootBaselineState = "missing" | "not_directory" | "empty" | "ok";

async function assessSyncRootForBaseline(
  rootPath: string
): Promise<RootBaselineState> {
  const resolved = path.resolve(rootPath);
  try {
    const st = await fs.lstat(resolved);
    if (st.isSymbolicLink()) {
      const real = await fs.realpath(resolved);
      const realSt = await fs.stat(real);
      if (!realSt.isDirectory()) {
        return "not_directory";
      }
      const entries = await fs.readdir(real);
      return entries.length === 0 ? "empty" : "ok";
    }
    if (!st.isDirectory()) {
      return "not_directory";
    }
    const entries = await fs.readdir(resolved);
    return entries.length === 0 ? "empty" : "ok";
  } catch (err) {
    if (isEnoent(err)) {
      return "missing";
    }
    return "not_directory";
  }
}

function baselineKeysUnderPrefix(
  baselineKeys: string[],
  prefix: "cursor-user/" | "dot-cursor/"
): string[] {
  return baselineKeys.filter((k) => k.startsWith(prefix));
}

export async function scanLocalAppConfigFiles(
  context: vscode.ExtensionContext,
  baseline?: AppStorageBaseline
): Promise<LocalConfigFileScan> {
  const roots = resolveSyncRoots(nodePlatform(), context);
  const resolvedRoots = await resolveSyncRootsRealpaths(roots);
  const enumConfig = getSyncEnumerationConfig(context);
  const localFiles = await enumerateSyncFiles(context, roots);
  const enumeratedKeys = new Set(localFiles.map((f) => f.relativeSyncKey));

  const checksums: Record<string, string> = {};
  const unreadableKeys = new Set<string>();
  const excludedKeys = new Set<string>();
  const oversizeKeys = new Set<string>();
  const symlinkKeys = new Set<string>();
  const enoentKeys = new Set<string>();
  const provablyAbsentKeys = new Set<string>();
  const skippedUnknownKeys = new Set<string>();
  const untrackedKeys = new Set<string>();
  const absentEligibleKeys = new Set<string>();

  for (const file of localFiles) {
    const key = file.relativeSyncKey;
    try {
      const stat = await fs.stat(file.absolutePath);
      if (!stat.isFile()) {
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
        if (stat.isSymbolicLink()) {
          symlinkKeys.add(key);
        }
        continue;
      }
      const buf = await fs.readFile(file.absolutePath);
      checksums[key] = computeChecksum(buf);
    } catch (err) {
      if (isEnoent(err)) {
        enoentKeys.add(key);
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
      } else {
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
      }
    }
  }

  const baselineLocalKeys = baseline ? Object.keys(baseline.localChecksums) : [];
  for (const key of baselineLocalKeys) {
    if (checksums[key] !== undefined) {
      continue;
    }
    if (isSyncKeyExcludedByConfig(key, enumConfig)) {
      excludedKeys.add(key);
      const absExcluded = syncKeyToAbsolutePath(key, roots);
      if (absExcluded) {
        try {
          await fs.lstat(absExcluded);
          skippedUnknownKeys.add(key);
          unreadableKeys.add(key);
        } catch {
        }
      }
      continue;
    }
    const absPath = syncKeyToAbsolutePath(key, roots);
    if (absPath) {
      try {
        const st = await fs.lstat(absPath);
        if (st.isSymbolicLink() || !st.isFile()) {
          skippedUnknownKeys.add(key);
          unreadableKeys.add(key);
          if (st.isSymbolicLink()) {
            symlinkKeys.add(key);
          }
          continue;
        }
        const rel = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
        const sizeLimit = rel.toLowerCase().endsWith(".vsix")
          ? 50 * 1024 * 1024
          : enumConfig.maxBytes;
        if (st.size > sizeLimit) {
          oversizeKeys.add(key);
          skippedUnknownKeys.add(key);
          unreadableKeys.add(key);
          continue;
        }
      } catch {
      }
    }
    const absForSafety = syncKeyToAbsolutePath(key, roots);
    if (absForSafety) {
      const rootInfo = key.startsWith("dot-cursor/")
        ? { rootPath: roots.dotCursor, rootReal: resolvedRoots.dotCursorReal }
        : key.startsWith("cursor-user/")
          ? { rootPath: roots.cursorUser, rootReal: resolvedRoots.cursorUserReal }
          : undefined;
      if (
        rootInfo &&
        (await pathHasUnsafeComponentBelowRoot(
          absForSafety,
          rootInfo.rootPath,
          rootInfo.rootReal
        ))
      ) {
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
        continue;
      }
    }
    const classification = await classifyLocalPath(context, key, resolvedRoots);
    if (classification === "proven_absent") {
      provablyAbsentKeys.add(key);
      enoentKeys.add(key);
      absentEligibleKeys.add(key);
      skippedUnknownKeys.delete(key);
      unreadableKeys.delete(key);
    } else if (classification === "skipped_unknown") {
      skippedUnknownKeys.add(key);
      unreadableKeys.add(key);
    }
  }

  const deleteBlockedRootPrefixes = new Set<string>();
  const baselineLocalKeysForRoots = baseline ? Object.keys(baseline.localChecksums) : [];
  const rootChecks: Array<{
    prefix: "cursor-user/" | "dot-cursor/";
    rootPath: string;
    tracked: string[];
  }> = [
    {
      prefix: "cursor-user/",
      rootPath: roots.cursorUser,
      tracked: baselineKeysUnderPrefix(baselineLocalKeysForRoots, "cursor-user/"),
    },
    {
      prefix: "dot-cursor/",
      rootPath: roots.dotCursor,
      tracked: baselineKeysUnderPrefix(baselineLocalKeysForRoots, "dot-cursor/"),
    },
  ];

  for (const { prefix, rootPath, tracked } of rootChecks) {
    if (tracked.length === 0) {
      continue;
    }
    const state = await assessSyncRootForBaseline(rootPath);
    if (state === "missing" || state === "not_directory" || state === "empty") {
      deleteBlockedRootPrefixes.add(prefix);
      for (const key of tracked) {
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
        provablyAbsentKeys.delete(key);
        absentEligibleKeys.delete(key);
        enoentKeys.delete(key);
        delete checksums[key];
      }
      continue;
    }
    const allTrackedAbsent = tracked.every((k) => provablyAbsentKeys.has(k));
    if (allTrackedAbsent) {
      deleteBlockedRootPrefixes.add(prefix);
    }
  }

  const cursorUserState = await assessSyncRootForBaseline(roots.cursorUser);
  const dotCursorState = await assessSyncRootForBaseline(roots.dotCursor);
  const userTracked =
    baselineKeysUnderPrefix(baselineLocalKeysForRoots, "cursor-user/").length > 0;
  const dotTracked =
    baselineKeysUnderPrefix(baselineLocalKeysForRoots, "dot-cursor/").length > 0;
  const rootsHealthyCombined =
    (!userTracked ||
      (cursorUserState !== "missing" && cursorUserState !== "not_directory")) &&
    (!dotTracked ||
      (dotCursorState !== "missing" && dotCursorState !== "not_directory"));

  const trackingScopeMismatch =
    baseline !== undefined && !trackingScopeMatches(baseline, enumConfig);

  let deletesAllowed = true;
  let deleteBlockReason: string | undefined;

  if (!rootsHealthyCombined) {
    deletesAllowed = false;
    deleteBlockReason = "A sync root directory is missing or unreadable";
  } else if (deleteBlockedRootPrefixes.size > 0) {
    deletesAllowed = false;
    deleteBlockReason =
      "A sync root is missing, empty, or all tracked keys under it appear absent";
  } else {
    const baselineUserKeys = baselineLocalKeys.filter(
      (k) => k !== GENERATED_EXTENSIONS_SYNC_KEY
    );
    const enumeratedUserKeys = [...enumeratedKeys].filter(
      (k) => k !== GENERATED_EXTENSIONS_SYNC_KEY
    );
    const inScopeBaselineKeys = baselineUserKeys.filter(
      (k) => !excludedKeys.has(k) && !oversizeKeys.has(k)
    );
    const trackedUserSeen =
      inScopeBaselineKeys.length === 0
        ? false
        : inScopeBaselineKeys.some(
            (k) => checksums[k] !== undefined || provablyAbsentKeys.has(k)
          );
    if (
      baselineUserKeys.length > 0 &&
      (enumeratedUserKeys.length === 0 || !trackedUserSeen)
    ) {
      deletesAllowed = false;
      deleteBlockReason =
        "Local scan found no user content files while baseline has tracked keys";
    }
  }
  return {
    checksums,
    unreadableKeys,
    excludedKeys,
    oversizeKeys,
    symlinkKeys,
    enoentKeys,
    provablyAbsentKeys,
    skippedUnknownKeys,
    untrackedKeys,
    absentEligibleKeys,
    deletesAllowed,
    deleteBlockReason,
    enumeratedCount: enumeratedKeys.size,
    rootsHealthy: rootsHealthyCombined,
    trackingScopeMismatch,
    deleteBlockedRootPrefixes,
  };
}

export function localFileMissingFromBaseline(
  key: string,
  scan: LocalConfigFileScan
): boolean {
  return scan.provablyAbsentKeys.has(key);
}
