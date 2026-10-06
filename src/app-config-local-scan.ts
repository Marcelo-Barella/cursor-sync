import * as fs from "node:fs/promises";
import type * as vscode from "vscode";
import { computeChecksum } from "./packaging.js";
import { enumerateSyncFiles, resolveSyncRoots } from "./paths.js";

export interface LocalConfigFileScan {
  checksums: Record<string, string>;
  unreadableKeys: Set<string>;
  enoentKeys: Set<string>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function scanLocalAppConfigFiles(
  context: vscode.ExtensionContext
): Promise<LocalConfigFileScan> {
  const roots = resolveSyncRoots(process.platform, context);
  const localFiles = await enumerateSyncFiles(context, roots);
  const checksums: Record<string, string> = {};
  const unreadableKeys = new Set<string>();
  const enoentKeys = new Set<string>();

  for (const file of localFiles) {
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
