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

export type BaselineKeyPresence = "present" | "provably_absent" | "skipped_unknown";

export interface LocalConfigFileScan {
  checksums: Record<string, string>;
  /** @deprecated use skippedUnknownKeys */
  unreadableKeys: Set<string>;
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

async function rootIsHealthy(rootPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(rootPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function checkProvableAbsence(absolutePath: string): Promise<BaselineKeyPresence> {
  const parentDir = path.dirname(absolutePath);
  const baseName = path.basename(absolutePath);
  let listing: string[];
  try {
    listing = await fs.readdir(parentDir);
  } catch {
    return "skipped_unknown";
  }

  if (listing.includes(baseName)) {
    try {
      const st = await fs.lstat(absolutePath);
      if (st.isFile()) {
        return "skipped_unknown";
      }
      return "skipped_unknown";
    } catch (err) {
      return isEnoent(err) ? "provably_absent" : "skipped_unknown";
    }
  }

  try {
    await fs.lstat(absolutePath);
    return "skipped_unknown";
  } catch (err) {
    return isEnoent(err) ? "provably_absent" : "skipped_unknown";
  }
}

async function classifyBaselineKey(
  context: vscode.ExtensionContext,
  roots: SyncRoots,
  syncKey: string,
  enumeratedKeys: Set<string>
): Promise<BaselineKeyPresence> {
  if (enumeratedKeys.has(syncKey)) {
    return "present";
  }

  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath) {
    return "skipped_unknown";
  }

  const enumConfig = getSyncEnumerationConfig(context);
  if (isSyncKeyExcludedByConfig(syncKey, enumConfig)) {
    return "skipped_unknown";
  }

  return checkProvableAbsence(absolutePath);
}

export async function scanLocalAppConfigFiles(
  context: vscode.ExtensionContext,
  baseline?: AppStorageBaseline
): Promise<LocalConfigFileScan> {
  const roots = resolveSyncRoots(process.platform, context);
  const enumConfig = getSyncEnumerationConfig(context);
  const localFiles = await enumerateSyncFiles(context, roots);
  const enumeratedKeys = new Set(localFiles.map((f) => f.relativeSyncKey));

  const checksums: Record<string, string> = {};
  const unreadableKeys = new Set<string>();
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
        continue;
      }
      const buf = await fs.readFile(file.absolutePath);
      checksums[key] = computeChecksum(buf);
    } catch (err) {
      if (isEnoent(err)) {
        enoentKeys.add(key);
        const presence = await checkProvableAbsence(file.absolutePath);
        if (presence === "provably_absent") {
          provablyAbsentKeys.add(key);
        } else {
          skippedUnknownKeys.add(key);
          unreadableKeys.add(key);
        }
      } else {
        skippedUnknownKeys.add(key);
        unreadableKeys.add(key);
      }
    }
  }

  async function markAbsentWhenAncestorDirectoryRemoved(syncKey: string): Promise<void> {
    const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
    if (!absolutePath) {
      return;
    }
    const rootPrefix = syncKey.startsWith("dot-cursor/")
      ? roots.dotCursor
      : syncKey.startsWith("cursor-user/")
        ? roots.cursorUser
        : undefined;
    if (!rootPrefix) {
      return;
    }
    let dir = path.dirname(absolutePath);
    while (dir.length >= rootPrefix.length && dir.startsWith(rootPrefix)) {
      if (dir === rootPrefix) {
        break;
      }
      const parentDir = path.dirname(dir);
      const dirName = path.basename(dir);
      try {
        const listing = await fs.readdir(parentDir);
        if (!listing.includes(dirName)) {
          provablyAbsentKeys.add(syncKey);
          enoentKeys.add(syncKey);
          skippedUnknownKeys.delete(syncKey);
          unreadableKeys.delete(syncKey);
          return;
        }
      } catch {
        dir = parentDir;
        continue;
      }
      dir = parentDir;
    }
  }

  const baselineLocalKeys = baseline ? Object.keys(baseline.localChecksums) : [];
  for (const key of baselineLocalKeys) {
    if (checksums[key] !== undefined) {
      continue;
    }
    if (isSyncKeyExcludedByConfig(key, enumConfig)) {
      untrackedKeys.add(key);
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
          continue;
        }
        const rel = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
        const sizeLimit = rel.toLowerCase().endsWith(".vsix")
          ? 50 * 1024 * 1024
          : enumConfig.maxBytes;
        if (st.size > sizeLimit) {
          untrackedKeys.add(key);
          skippedUnknownKeys.add(key);
          unreadableKeys.add(key);
          continue;
        }
      } catch {
      }
    }
    if (provablyAbsentKeys.has(key) || enoentKeys.has(key)) {
      skippedUnknownKeys.delete(key);
      unreadableKeys.delete(key);
      continue;
    }
    await markAbsentWhenAncestorDirectoryRemoved(key);
    if (provablyAbsentKeys.has(key)) {
      skippedUnknownKeys.delete(key);
      unreadableKeys.delete(key);
      enoentKeys.add(key);
      continue;
    }
    const presence = await classifyBaselineKey(context, roots, key, enumeratedKeys);
    if (presence === "provably_absent") {
      provablyAbsentKeys.add(key);
      enoentKeys.add(key);
      skippedUnknownKeys.delete(key);
      unreadableKeys.delete(key);
    } else if (presence === "skipped_unknown") {
      skippedUnknownKeys.add(key);
      unreadableKeys.add(key);
    }
  }

  const cursorUserOk = await rootIsHealthy(roots.cursorUser);
  const dotCursorOk = await rootIsHealthy(roots.dotCursor);
  const rootsHealthy = cursorUserOk && dotCursorOk;

  const trackingScopeMismatch =
    baseline !== undefined && !trackingScopeMatches(baseline, enumConfig);

  let deletesAllowed = true;
  let deleteBlockReason: string | undefined;

  if (!rootsHealthy) {
    deletesAllowed = false;
    deleteBlockReason = "A sync root directory is missing or unreadable";
  } else {
    const baselineUserKeys = baselineLocalKeys.filter(
      (k) => k !== GENERATED_EXTENSIONS_SYNC_KEY
    );
    const enumeratedUserKeys = [...enumeratedKeys].filter(
      (k) => k !== GENERATED_EXTENSIONS_SYNC_KEY
    );
    const trackedUserSeen = baselineUserKeys.some(
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
  if (deletesAllowed && trackingScopeMismatch) {
    deletesAllowed = false;
    deleteBlockReason = "Sync paths or limits changed since the baseline was saved";
  }

  return {
    checksums,
    unreadableKeys,
    enoentKeys,
    provablyAbsentKeys,
    skippedUnknownKeys,
    untrackedKeys,
    absentEligibleKeys,
    deletesAllowed,
    deleteBlockReason,
    enumeratedCount: enumeratedKeys.size,
    rootsHealthy,
    trackingScopeMismatch,
  };
}

export function localFileMissingFromBaseline(
  key: string,
  scan: LocalConfigFileScan
): boolean {
  return scan.provablyAbsentKeys.has(key);
}
