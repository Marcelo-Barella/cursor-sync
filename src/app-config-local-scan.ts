import * as path from "node:path";
import * as fs from "node:fs/promises";
import type * as vscode from "vscode";
import { computeChecksum } from "./packaging.js";
import { enumerateSyncFiles, resolveSyncRoots, type SyncRoots } from "./paths.js";

function syncKeyToAbsolutePath(syncKey: string, roots: SyncRoots): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }
  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }
  return undefined;
}

export interface LocalConfigFileScan {
  checksums: Record<string, string>;
  unreadableKeys: Set<string>;
  enoentKeys: Set<string>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function scanLocalAppConfigFiles(
  context: vscode.ExtensionContext,
  options?: { probeBaselineKeys?: string[] }
): Promise<LocalConfigFileScan> {
  const roots = resolveSyncRoots(process.platform, context);
  const localFiles = await enumerateSyncFiles(context, roots);
  const checksums: Record<string, string> = {};
  const unreadableKeys = new Set<string>();
  const enoentKeys = new Set<string>();
  const seenKeys = new Set<string>();

  for (const file of localFiles) {
    seenKeys.add(file.relativeSyncKey);
    const key = file.relativeSyncKey;
    try {
      const stat = await fs.stat(file.absolutePath);
      if (!stat.isFile()) {
        unreadableKeys.add(key);
        continue;
      }
      const buf = await fs.readFile(file.absolutePath);
      checksums[key] = computeChecksum(buf);
    } catch (err) {
      if (isEnoent(err)) {
        enoentKeys.add(key);
      } else {
        unreadableKeys.add(key);
      }
    }
  }

  for (const key of options?.probeBaselineKeys ?? []) {
    if (seenKeys.has(key) || checksums[key] !== undefined) {
      continue;
    }
    if (unreadableKeys.has(key) || enoentKeys.has(key)) {
      continue;
    }
    const absolutePath = syncKeyToAbsolutePath(key, roots);
    if (!absolutePath) {
      continue;
    }
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        unreadableKeys.add(key);
      }
    } catch (err) {
      if (isEnoent(err)) {
        enoentKeys.add(key);
      } else {
        unreadableKeys.add(key);
      }
    }
  }

  return { checksums, unreadableKeys, enoentKeys };
}

export function localFileMissingFromBaseline(
  key: string,
  scan: LocalConfigFileScan
): boolean {
  if (scan.checksums[key] !== undefined) {
    return false;
  }
  return !scan.unreadableKeys.has(key);
}
