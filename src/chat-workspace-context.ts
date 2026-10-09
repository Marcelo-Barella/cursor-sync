import * as fs from "node:fs/promises";
import { USER_LABEL_DOT_CURSOR, USER_LABEL_DOT_CURSOR_CHATS, USER_LABEL_DOT_CURSOR_PROJECTS, USER_LABEL_HOME_TILDE_PREFIX } from "./paths.js";
import { isWin32Platform } from "./os-runtime.js";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveExtensionSyncRoots, resolveUserHomeDir } from "./sync-roots.js";

export function stateDbPathForWorkspaceStorageId(workspaceStorageId: string): string {
  const { cursorUser } = resolveExtensionSyncRoots();
  return path.join(cursorUser, "workspaceStorage", workspaceStorageId, "state.vscdb");
}

export interface WorkspaceIdentifierUri {
  $mid: number;
  fsPath: string;
  _sep: number;
  external: string;
  path: string;
  scheme: string;
}

export interface WorkspaceIdentifier {
  id: string;
  uri: WorkspaceIdentifierUri;
}

export interface WorkspaceContext {
  workspaceStorageId: string;
  folderFsPath: string;
  chatsWorkspaceKey: string;
  workspaceIdentifier: WorkspaceIdentifier;
}

export interface ResolveWorkspaceContextOptions {
  stateDbPath?: string;
  workspaceFolder?: string;
}

export function md5FolderKey(folderFsPath: string): string {
  return createHash("md5").update(folderFsPath, "utf8").digest("hex");
}

/** Same encoding as transport-chat `folder_to_project_key` (~/.cursor/projects/<name>). */
export function folderToProjectKey(folderFsPath: string): string {
  const resolved = path.resolve(folderFsPath);
  return resolved.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
}

export function folderPathFromWorkspaceUri(uri: string): string {
  if (uri.startsWith("file://")) {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname);
  }
  return uri;
}

function expandUserFolder(folder: string): string {
  const userHome = resolveUserHomeDir();
  if (folder === "~") {
    return userHome;
  }
  if (folder.startsWith(USER_LABEL_HOME_TILDE_PREFIX)) {
    return path.join(userHome, folder.slice(USER_LABEL_HOME_TILDE_PREFIX.length));
  }
  return folder;
}

function workspaceStorageIdFromStateDb(stateDbPath: string): string | undefined {
  const parts = stateDbPath.split(path.sep);
  const idx = parts.indexOf("workspaceStorage");
  if (idx >= 0 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return undefined;
}

export async function folderFromWorkspaceJson(
  workspaceJsonPath: string
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(workspaceJsonPath, "utf8");
    const data = JSON.parse(raw) as { folder?: unknown };
    const folder = data.folder;
    if (typeof folder === "string") {
      return folderPathFromWorkspaceUri(folder);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function buildChatsKeyToFolderMap(
  cursorUser: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wsRoot = path.join(cursorUser, "workspaceStorage");
  let entries: string[];
  try {
    entries = await fs.readdir(wsRoot);
  } catch {
    return map;
  }
  for (const ent of entries) {
    const wj = path.join(wsRoot, ent, "workspace.json");
    const folder = await folderFromWorkspaceJson(wj);
    if (!folder) {
      continue;
    }
    const folderFsPath = path.resolve(folder);
    map.set(md5FolderKey(folderFsPath), folderFsPath);
  }
  return map;
}

export async function scanWorkspaceStorageForFolder(
  folderFsPath: string
): Promise<string | undefined> {
  const { cursorUser } = resolveExtensionSyncRoots();
  const wsRoot = path.join(cursorUser, "workspaceStorage");
  return scanWorkspaceStorageForId(wsRoot, path.resolve(folderFsPath));
}

async function scanWorkspaceStorageForId(
  wsRoot: string,
  folderFsPath: string
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(wsRoot);
  } catch {
    return undefined;
  }

  for (const ent of entries) {
    const wj = path.join(wsRoot, ent, "workspace.json");
    try {
      const stat = await fs.stat(wj);
      if (!stat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    const folder = await folderFromWorkspaceJson(wj);
    if (folder === undefined) {
      continue;
    }
    if (path.resolve(folder) === folderFsPath) {
      return ent;
    }
  }
  return undefined;
}

function buildWorkspaceIdentifier(
  wsId: string,
  folderFsPath: string
): WorkspaceIdentifier {
  const sep = isWin32Platform() ? 1 : 47;
  const external = pathToFileURL(folderFsPath).href;
  return {
    id: wsId,
    uri: {
      $mid: 1,
      fsPath: folderFsPath,
      _sep: sep,
      external,
      path: folderFsPath,
      scheme: "file",
    },
  };
}

export async function resolveWorkspaceContext(
  options: ResolveWorkspaceContextOptions = {}
): Promise<WorkspaceContext | null> {
  let folderFsPath: string | undefined;
  let workspaceStorageId: string | undefined;

  if (options.workspaceFolder?.trim()) {
    folderFsPath = path.resolve(expandUserFolder(options.workspaceFolder.trim()));
  }

  if (options.stateDbPath) {
    const stateDbPath = path.resolve(options.stateDbPath);
    workspaceStorageId = workspaceStorageIdFromStateDb(stateDbPath);
    if (!folderFsPath) {
      const parentName = path.basename(path.dirname(stateDbPath));
      if (parentName !== "globalStorage") {
        const wj = path.join(path.dirname(stateDbPath), "workspace.json");
        folderFsPath = await folderFromWorkspaceJson(wj);
      }
    }
  }

  if (!folderFsPath) {
    return null;
  }

  folderFsPath = path.resolve(folderFsPath);
  const chatsKey = md5FolderKey(folderFsPath);

  if (!workspaceStorageId) {
    const { cursorUser } = resolveExtensionSyncRoots();
    const wsRoot = path.join(cursorUser, "workspaceStorage");
    workspaceStorageId = await scanWorkspaceStorageForId(wsRoot, folderFsPath);
  }

  const wsId = workspaceStorageId ?? chatsKey;
  return {
    workspaceStorageId: wsId,
    folderFsPath,
    chatsWorkspaceKey: chatsKey,
    workspaceIdentifier: buildWorkspaceIdentifier(wsId, folderFsPath),
  };
}

export async function requireWorkspaceContext(
  options: ResolveWorkspaceContextOptions = {}
): Promise<WorkspaceContext> {
  const ctx = await resolveWorkspaceContext(options);
  if (ctx) {
    return ctx;
  }
  throw new Error(
    `Workspace folder is required for chat import: sets ${USER_LABEL_DOT_CURSOR}/chats/<md5(folder)> store.db path and stamps workspaceIdentifier on composer headers.`
  );
}

export async function resolveChatsWorkspaceKey(
  targetWorkspace: string | undefined,
  stateDbPath: string | undefined,
  workspaceFolder: string | undefined,
  bundle: { storeSnapshot?: { sourceWorkspaceKey?: string } | null }
): Promise<{ key: string; warnings: string[] }> {
  const warnings: string[] = [];
  const ctx = await resolveWorkspaceContext({
    stateDbPath,
    workspaceFolder,
  });

  if (ctx) {
    if (targetWorkspace && targetWorkspace !== ctx.chatsWorkspaceKey) {
      if (targetWorkspace === ctx.workspaceStorageId) {
        warnings.push(
          `--target-workspace ${targetWorkspace} is workspaceStorage id; using chats key md5(folder)=${ctx.chatsWorkspaceKey} for store.db.`
        );
      } else {
        warnings.push(
          `--target-workspace ${targetWorkspace} overrides resolved chats key ${ctx.chatsWorkspaceKey}.`
        );
        return { key: targetWorkspace, warnings };
      }
    }
    return { key: ctx.chatsWorkspaceKey, warnings };
  }

  if (targetWorkspace) {
    return { key: targetWorkspace, warnings };
  }

  const swk = bundle.storeSnapshot?.sourceWorkspaceKey;
  if (typeof swk === "string" && swk.length > 0) {
    return { key: swk, warnings };
  }

  return { key: "imported", warnings };
}
