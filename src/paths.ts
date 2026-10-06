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

const MAX_SYNC_VSIX_BYTES = 50 * 1024 * 1024;

function defaultSyncRoots(platform: NodeJS.Platform): SyncRoots {
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

export function deriveCursorUserDirFromGlobalStorage(
  globalStorageUri: vscode.Uri
): string | undefined {
  const globalStoragePath = globalStorageUri.fsPath;
  const globalStorageDir = path.dirname(globalStoragePath);
  if (path.basename(globalStorageDir) !== "globalStorage") {
    return undefined;
  }
  const userDir = path.dirname(globalStorageDir);
  if (path.basename(userDir) !== "User") {
    return undefined;
  }
  return userDir;
}

function resolveDotCursorDir(platform: NodeJS.Platform, fallback: string): string {
  const fromEnv = process.env["CURSOR_DOT_DIR"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return fallback;
}

export function globalStateVscdbPathsFromRoots(roots: SyncRoots): string[] {
  const primary = path.join(roots.cursorUser, "globalStorage", "state.vscdb");
  const nightlyUser = roots.cursorUser.replace(
    /([/\\])Cursor([/\\])User$/,
    "$1Cursor Nightly$2User"
  );
  if (nightlyUser === roots.cursorUser) {
    return [primary];
  }
  return [primary, path.join(nightlyUser, "globalStorage", "state.vscdb")];
}

export function workspaceStorageRootsFromCursorUser(cursorUser: string): string[] {
  const primary = path.join(cursorUser, "workspaceStorage");
  const nightlyUser = cursorUser.replace(
    /([/\\])Cursor([/\\])User$/,
    "$1Cursor Nightly$2User"
  );
  if (nightlyUser === cursorUser) {
    return [primary];
  }
  return [primary, path.join(nightlyUser, "workspaceStorage")];
}

export function resolveSyncRoots(
  platform: NodeJS.Platform = process.platform,
  context?: vscode.ExtensionContext
): SyncRoots {
  const defaults = defaultSyncRoots(platform);

  if (context?.globalStorageUri !== undefined) {
    const fromContext = deriveCursorUserDirFromGlobalStorage(context.globalStorageUri);
    if (fromContext) {
      return {
        cursorUser: fromContext,
        dotCursor: resolveDotCursorDir(platform, defaults.dotCursor),
      };
    }
  }

  return {
    cursorUser: defaults.cursorUser,
    dotCursor: resolveDotCursorDir(platform, defaults.dotCursor),
  };
}

export interface SyncEnumerationConfig {
  enabledPaths: string[];
  excludeGlobs: string[];
  maxFileSizeKB: number;
  maxBytes: number;
  cursorUserGlobs: string[];
  dotCursorGlobs: string[];
}

export function getSyncEnumerationConfig(
  context: vscode.ExtensionContext
): SyncEnumerationConfig {
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
      g.startsWith("snippets") ||
      g.startsWith("vsix")
  );
  const dotCursorGlobs = enabledPaths.filter(
    (g) =>
      (g.startsWith("skills") && !g.startsWith("skills-cursor")) ||
      g.startsWith("commands") ||
      g.startsWith("rules")
  );

  return {
    enabledPaths,
    excludeGlobs,
    maxFileSizeKB,
    maxBytes,
    cursorUserGlobs,
    dotCursorGlobs,
  };
}

export function syncKeyToAbsolutePath(
  syncKey: string,
  roots: SyncRoots
): string | undefined {
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

export function isSyncKeyExcludedByConfig(
  syncKey: string,
  enumConfig: SyncEnumerationConfig
): boolean {
  const slash = syncKey.indexOf("/");
  if (slash < 0) {
    return true;
  }
  const prefix = syncKey.slice(0, slash);
  const rel = syncKey.slice(slash + 1);
  if (prefix !== "cursor-user" && prefix !== "dot-cursor") {
    return true;
  }
  if (isDenylisted(rel)) {
    return true;
  }
  if (prefix === "dot-cursor" && rel.split("/")[0] === "skills-cursor") {
    return true;
  }
  const globs =
    prefix === "cursor-user" ? enumConfig.cursorUserGlobs : enumConfig.dotCursorGlobs;
  const matchesInclude = globs.some((g) => minimatch(rel, g));
  if (!matchesInclude) {
    return true;
  }
  return enumConfig.excludeGlobs.some((g) => minimatch(rel, g));
}

export async function enumerateSyncFiles(
  context: vscode.ExtensionContext,
  roots?: SyncRoots
): Promise<SyncFileEntry[]> {
  const resolved = roots ?? resolveSyncRoots(process.platform, context);
  const enumConfig = getSyncEnumerationConfig(context);
  const { excludeGlobs, maxBytes, cursorUserGlobs, dotCursorGlobs } = enumConfig;

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

  try {
    const rootStat = await fs.lstat(rootDir);
    if (rootStat.isSymbolicLink()) {
      return;
    }
  } catch {
    return;
  }

  const allFiles = await walkDirectory(rootDir);
  for (const absPath of allFiles) {
    const rel = path.relative(rootDir, absPath).split(path.sep).join("/");

    if (isDenylisted(rel)) {
      continue;
    }

    if (prefix === "dot-cursor" && rel.split("/")[0] === "skills-cursor") {
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
      const sizeLimit = rel.toLowerCase().endsWith(".vsix")
        ? MAX_SYNC_VSIX_BYTES
        : maxBytes;
      if (stat.size > sizeLimit) {
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
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      st = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      continue;
    }
    if (st.isDirectory()) {
      const sub = await walkDirectory(fullPath);
      results.push(...sub);
    } else if (st.isFile()) {
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
    "vsix/**",
    "skills/**",
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
