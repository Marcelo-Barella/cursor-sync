import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  escapeSqlLiteral,
  mergeComposerHeadersChain,
} from "./composer-merge.js";
import { getActiveExtensionContext } from "./extension-host-context.js";
import { deriveCursorUserDirFromGlobalStorage } from "./paths.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows, runSqliteScript, listGlobalStateVscdbPaths } = __chatPersistenceInternals;

export function getWorkspaceStorageRootCandidates(
  context?: vscode.ExtensionContext
): string[] {
  const ctx = context ?? getActiveExtensionContext();
  if (ctx?.globalStorageUri) {
    const cursorUser = deriveCursorUserDirFromGlobalStorage(ctx.globalStorageUri);
    if (cursorUser) {
      return [path.join(cursorUser, "workspaceStorage")];
    }
  }
  return [];
}

export async function resolveWorkspaceStateDbPath(
  folderId: string,
  context?: vscode.ExtensionContext
): Promise<string | undefined> {
  for (const root of getWorkspaceStorageRootCandidates(context)) {
    const candidate = path.join(root, folderId, "state.vscdb");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

export interface StateTargetSpec {
  stateTarget: "global" | "workspace";
  workspaceStorageFolderId?: string;
}

export async function resolveLiveStateDbPath(
  spec: StateTargetSpec,
  context?: vscode.ExtensionContext
): Promise<string | undefined> {
  if (spec.stateTarget === "global") {
    const candidates = await listGlobalStateVscdbPaths();
    return candidates[0];
  }
  const id = spec.workspaceStorageFolderId;
  if (!id) {
    return undefined;
  }
  return resolveWorkspaceStateDbPath(id, context);
}

export async function copyStateDbTriple(
  liveDbPath: string,
  destDir: string
): Promise<{ main: string; wal?: string; shm?: string }> {
  await fs.mkdir(destDir, { recursive: true });
  const outMain = path.join(destDir, "state.vscdb");
  await fs.copyFile(liveDbPath, outMain);
  const walSrc = `${liveDbPath}-wal`;
  const shmSrc = `${liveDbPath}-shm`;
  let wal: string | undefined;
  let shm: string | undefined;
  try {
    const outWal = path.join(destDir, "state.vscdb-wal");
    await fs.copyFile(walSrc, outWal);
    wal = outWal;
  } catch {}
  try {
    const outShm = path.join(destDir, "state.vscdb-shm");
    await fs.copyFile(shmSrc, outShm);
    shm = outShm;
  } catch {}
  return { main: outMain, wal, shm };
}

export async function runWalCheckpointFull(dbPath: string): Promise<void> {
  await runSqliteScript(dbPath, "PRAGMA wal_checkpoint(FULL);\n");
}

export async function mergeComposerHeadersIntoDb(
  dbPath: string,
  headerPayloads: Array<Record<string, unknown>>
): Promise<void> {
  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');"
  );
  let existingHeadersRaw: string | undefined;
  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    if (key === "composer.composerHeaders") {
      if (typeof value === "string") {
        existingHeadersRaw = value;
      } else if (value != null && typeof value === "object") {
        existingHeadersRaw = JSON.stringify(value);
      }
    }
  }
  const mergedHeaders = mergeComposerHeadersChain(existingHeadersRaw, headerPayloads);
  const mergedJson = JSON.stringify(mergedHeaders);
  const escaped = escapeSqlLiteral(mergedJson);
  const script =
    `BEGIN IMMEDIATE;\n` +
    `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';\n` +
    `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n` +
    `COMMIT;\n`;
  await runSqliteScript(dbPath, script);
}

export async function runMetadataSqlOnShadowDb(dbPath: string, sqlChunks: string[]): Promise<void> {
  for (const chunk of sqlChunks) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
      continue;
    }
    await runSqliteScript(dbPath, trimmed.endsWith(";") ? trimmed : `${trimmed};\n`);
  }
}
