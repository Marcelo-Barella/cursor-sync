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

export type DiskProbeResult = "present" | "absent_eligible" | "skipped_unknown";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function parentDirectoryReadable(parentDir: string): Promise<boolean> {
  try {
    await fs.readdir(parentDir);
    return true;
  } catch {
    return false;
  }
}

export async function probeSyncKeyOnDisk(
  context: vscode.ExtensionContext,
  syncKey: string
): Promise<DiskProbeResult> {
  const enumConfig = getSyncEnumerationConfig(context);
  const roots = resolveSyncRoots(process.platform, context);
  const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
  if (!absolutePath) {
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
    const parentDir = path.dirname(absolutePath);
    if (!(await parentDirectoryReadable(parentDir))) {
      return "skipped_unknown";
    }
    return "absent_eligible";
  }
}

export function applyDiskProbeToScan(
  scan: LocalConfigFileScan,
  syncKey: string,
  probe: DiskProbeResult
): void {
  scan.untrackedKeys.delete(syncKey);
  scan.provablyAbsentKeys.delete(syncKey);
  scan.absentEligibleKeys.delete(syncKey);
  scan.enoentKeys.delete(syncKey);

  if (probe === "present") {
    scan.skippedUnknownKeys.delete(syncKey);
    scan.unreadableKeys.delete(syncKey);
    return;
  }
  if (probe === "absent_eligible") {
    scan.skippedUnknownKeys.delete(syncKey);
    scan.unreadableKeys.delete(syncKey);
    scan.absentEligibleKeys.add(syncKey);
    scan.provablyAbsentKeys.add(syncKey);
    scan.enoentKeys.add(syncKey);
    return;
  }
  scan.skippedUnknownKeys.add(syncKey);
  scan.unreadableKeys.add(syncKey);
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
    const probe = await probeSyncKeyOnDisk(context, key);
    applyDiskProbeToScan(next, key, probe);
  }
  return next;
}
