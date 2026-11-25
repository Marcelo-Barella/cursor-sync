import * as fs from "node:fs/promises";
import { systemTmpDir } from "../os-runtime.js";
import * as path from "node:path";
import type * as vscode from "vscode";

export interface BundleDiscoveryEntry {
  bundlePath: string;
  bytes: number;
  modifiedAt: string;
  source: "tmp" | "globalStorage";
}

export async function listLocalBundles(
  context: vscode.ExtensionContext
): Promise<BundleDiscoveryEntry[]> {
  const out: BundleDiscoveryEntry[] = [];
  const tmpDir = systemTmpDir();
  try {
    const entries = await fs.readdir(tmpDir);
    for (const name of entries) {
      if (!name.startsWith("chat-transport-") || !name.endsWith(".json")) continue;
      const full = path.join(tmpDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          out.push({
            bundlePath: full,
            bytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            source: "tmp",
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  const gs = path.join(context.globalStorageUri.fsPath, "chat-bundles");
  try {
    const entries = await fs.readdir(gs);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(gs, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          out.push({
            bundlePath: full,
            bytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            source: "globalStorage",
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
