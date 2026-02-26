import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import type { SyncFileEntry } from "./types.js";

export interface SyncRoots {
  cursorUser: string;
  dotCursor: string;
}

const DENYLIST_DIRS = [
  "extensions",
  "logs",
  "CachedData",
  "CachedExtensions",
  "CachedProfilesData",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "blob_storage",
  "Local Storage",
  "Session Storage",
  "Network",
  "shared_proto_db",
  "databases",
];

const DENYLIST_FILES = ["TransportSecurity"];

const DENYLIST_GLOBS = ["Cookies*", "*.db", "*.db-journal", "*.db-wal", "*.log"];

export function resolveSyncRoots(
  platform: NodeJS.Platform = process.platform
): SyncRoots {
  if (platform === "win32") {
    const appData = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming");
    const userProfile = process.env["USERPROFILE"] || os.homedir();
    return {
      cursorUser: path.join(appData, "Cursor", "User"),
      dotCursor: path.join(userProfile, ".cursor"),
    };
  }

  if (platform === "darwin") {
    const home = os.homedir();
    return {
      cursorUser: path.join(home, "Library", "Application Support", "Cursor", "User"),
      dotCursor: path.join(home, ".cursor"),
    };
  }

  const configHome = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return {
    cursorUser: path.join(configHome, "Cursor", "User"),
    dotCursor: path.join(os.homedir(), ".cursor"),
  };
}

export async function enumerateSyncFiles(
  roots?: SyncRoots
): Promise<SyncFileEntry[]> {
  const resolved = roots ?? resolveSyncRoots();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabledPaths = config.get<string[]>("enabledPaths") ?? getDefaultEnabledPaths();
  const excludeGlobs = config.get<string[]>("excludeGlobs") ?? [];
  const maxFileSizeKB = config.get<number>("maxFileSizeKB") ?? 512;
  const maxBytes = maxFileSizeKB * 1024;

  const cursorUserGlobs = enabledPaths.filter(
    (g) =>
      g === "settings.json" ||
      g === "keybindings.json" ||
      g === "extensions.json" ||
      g.startsWith("snippets")
  );
  const dotCursorGlobs = enabledPaths.filter(
    (g) =>
      g.startsWith("skills") ||
      g.startsWith("commands") ||
      g.startsWith("rules")
  );

  const entries: SyncFileEntry[] = [];

  await collectFiles(
    resolved.cursorUser,
    "cursor-user",
    cursorUserGlobs,
    excludeGlobs,
    maxBytes,
    entries
  );
  await collectFiles(
    resolved.dotCursor,
    "dot-cursor",
    dotCursorGlobs,
    excludeGlobs,
    maxBytes,
    entries
  );

  return entries.sort((a, b) => a.relativeSyncKey.localeCompare(b.relativeSyncKey));
}

async function collectFiles(
  rootDir: string,
  prefix: string,
  includeGlobs: string[],
  excludeGlobs: string[],
  maxBytes: number,
  result: SyncFileEntry[]
): Promise<void> {
  const exists = await dirExists(rootDir);
  if (!exists) {
    return;
  }

  const allFiles = await walkDirectory(rootDir);
  for (const absPath of allFiles) {
    const rel = path.relative(rootDir, absPath).split(path.sep).join("/");

    if (isDenylisted(rel)) {
      continue;
    }

    const matchesInclude = includeGlobs.some((g) => minimatch(rel, g));
    if (!matchesInclude) {
      continue;
    }

    const matchesExclude = excludeGlobs.some((g) => minimatch(rel, g));
    if (matchesExclude) {
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      if (stat.size > maxBytes) {
        continue;
      }
    } catch {
      continue;
    }

    result.push({
      absolutePath: absPath,
      relativeSyncKey: `${prefix}/${rel}`,
    });
  }
}

function isDenylisted(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const topDir = parts[0];

  if (topDir && DENYLIST_DIRS.includes(topDir)) {
    return true;
  }

  const fileName = parts[parts.length - 1];
  if (fileName && DENYLIST_FILES.includes(fileName)) {
    return true;
  }

  if (fileName) {
    for (const glob of DENYLIST_GLOBS) {
      if (minimatch(fileName, glob)) {
        return true;
      }
    }
  }

  return false;
}

async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDirectory(fullPath);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function getDefaultEnabledPaths(): string[] {
  return [
    "settings.json",
    "keybindings.json",
    "snippets/**",
    "extensions.json",
    "skills/**/SKILL.md",
    "skills-cursor/**/SKILL.md",
    "commands/**/*.md",
    "rules/*.mdc",
  ];
}

export function syncKeyToGistFileName(syncKey: string): string {
  return syncKey.replace(/\//g, "--");
}

export function gistFileNameToSyncKey(gistFileName: string): string {
  return gistFileName.replace(/--/g, "/");
}
