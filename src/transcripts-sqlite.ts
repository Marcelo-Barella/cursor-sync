import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  execFileAsync,
  execFileWithStdinAsync,
  isWin32Platform,
  sqlite3CliArgs,
  subprocessCommandBasename,
  systemTmpDir,
} from "./os-runtime.js";
import {
  isSubprocessCommandNotFoundError,
  SubprocessCommandNotFoundError,
} from "./subprocess-errors.js";
import {
  assertSafeSqlScript,
  assertValidSqlScriptUnicode,
  SQLITE_PYTHON_EXECUTESCRIPT,
} from "./sqlite-script-safety.js";
import { getComposerId } from "./composer-merge.js";
import {
  globalStateVscdbPathsFromRoots,
  workspaceStorageRootsFromCursorUser,
} from "./paths.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import type * as vscode from "vscode";

export const SQLITE_SUBPROCESS_TIMEOUT_MS = 20_000;
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export const SQLITE_PYTHON_FALLBACK_SCRIPT = [
  "import json, sqlite3, sys",
  "db_path = sys.argv[1]",
  "sql = sys.argv[2]",
  `conn = sqlite3.connect(db_path, timeout=${Math.ceil(SQLITE_SUBPROCESS_TIMEOUT_MS / 1000)})`,
  `conn.execute('PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}')`,
  "conn.row_factory = sqlite3.Row",
  "cur = conn.cursor()",
  "cur.execute(sql)",
  "rows = [{k: (bytes(r[k]).hex() if isinstance(r[k], (bytes, bytearray, memoryview)) else r[k]) for k in r.keys()} for r in cur.fetchall()]",
  "print(json.dumps(rows))",
  "conn.close()",
].join(";");
export const SQLITE_RETRY_BACKOFF_MS = 1_500;
export const FILE_ACCESS_TIMEOUT_MS = 12_000;
/** Above this size, the sqlite3 CLI often stalls on WAL-backed state.vscdb; prefer Python. */
export const SQLITE_PYTHON_PREFER_BYTES = 256 * 1024 * 1024;

type PythonSqliteInterpreter = {
  command: string;
  argvPrefix: readonly string[];
};

let pythonInterpreterResolvePromise: Promise<PythonSqliteInterpreter> | null = null;

async function probePythonInterpreter(): Promise<PythonSqliteInterpreter> {
  const probe = "import sqlite3; raise SystemExit(0)";
  const execOpts = { maxBuffer: 64 * 1024, timeout: 5000 };
  const candidates: PythonSqliteInterpreter[] = [
    { command: "python3", argvPrefix: [] },
    { command: "python", argvPrefix: [] },
  ];
  if (isWin32Platform()) {
    candidates.push({ command: "py", argvPrefix: ["-3"] });
  }
  for (const c of candidates) {
    try {
      const args = [...c.argvPrefix, "-c", probe];
      await execFileAsync(c.command, args, execOpts);
      return c;
    } catch {
      continue;
    }
  }
  throw new Error(
    "No Python with the sqlite3 module found (tried python3, python" +
      (isWin32Platform() ? ", py -3" : "") +
      "). Install Python, add the SQLite CLI (sqlite3) to PATH, or both."
  );
}

export async function resolvePythonInterpreterForSqlite(): Promise<PythonSqliteInterpreter> {
  if (!pythonInterpreterResolvePromise) {
    pythonInterpreterResolvePromise = probePythonInterpreter().catch((err) => {
      pythonInterpreterResolvePromise = null;
      throw err;
    });
  }
  return pythonInterpreterResolvePromise;
}

export function isExecFileTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const e = error as { killed?: boolean; code?: string; message?: string };
  if (e.killed === true) {
    return true;
  }
  if (e.code === "ETIMEDOUT") {
    return true;
  }
  const msg = typeof e.message === "string" ? e.message : "";
  return msg.includes("timed out") || msg.includes("ETIMEDOUT");
}

export async function accessPathOutcome(absPath: string): Promise<"exists" | "missing" | "timeout"> {
  let settled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve("timeout");
      }
    }, FILE_ACCESS_TIMEOUT_MS);
    fs.access(absPath)
      .then(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve("exists");
      })
      .catch(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve("missing");
      });
  });
}

export async function querySqliteRowsImpl(
  runQuery: (dbPath: string, sql: string) => Promise<{ stdout: string; stderr: string }>,
  dbPath: string,
  sql: string,
  opts?: { retries?: number }
): Promise<Array<Record<string, unknown>>> {
  const maxAttempts = opts?.retries ?? 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { stdout } = await runQuery(dbPath, sql);
      const trimmed = stdout.trim();
      if (!trimmed) {
        return [];
      }

      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
        : [];
    } catch (error) {
      if (isExecFileTimeoutError(error) && attempt < maxAttempts - 1) {
        const delay = SQLITE_RETRY_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  throw new Error("querySqliteRowsImpl: exhausted retries without result");
}

export async function querySqliteRows(
  dbPath: string,
  sql: string,
  opts?: { retries?: number }
): Promise<Array<Record<string, unknown>>> {
  return querySqliteRowsImpl(runSqliteQuery, dbPath, sql, opts);
}

async function preferPythonForDbFile(dbPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dbPath);
    return stat.size >= SQLITE_PYTHON_PREFER_BYTES;
  } catch {
    return false;
  }
}

async function runPythonSqliteQuery(
  dbPath: string,
  sql: string,
  execOpts: { maxBuffer: number; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  const py = await resolvePythonInterpreterForSqlite();
  const args = [...py.argvPrefix, "-c", SQLITE_PYTHON_FALLBACK_SCRIPT, dbPath, sql];
  return execFileAsync(py.command, args, execOpts);
}

export async function runSqliteQuery(
  dbPath: string,
  sql: string
): Promise<{ stdout: string; stderr: string }> {
  const execOpts = { maxBuffer: 64 * 1024 * 1024, timeout: SQLITE_SUBPROCESS_TIMEOUT_MS };
  if (await preferPythonForDbFile(dbPath)) {
    return runPythonSqliteQuery(dbPath, sql, execOpts);
  }
  try {
    return await execFileAsync("sqlite3", sqlite3CliArgs(["-json", dbPath, sql]), execOpts);
  } catch (error) {
    if (!isSqlite3UnavailableError(error)) {
      throw error;
    }
    return runPythonSqliteQuery(dbPath, sql, execOpts);
  }
}

/** True when the sqlite3 CLI cannot be invoked (missing, blocked, or unusable shim). */
export function isSqlite3UnavailableError(error: unknown): boolean {
  if (isCommandMissingError(error, "sqlite3") || isExecFileTimeoutError(error)) {
    return true;
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === 127 || code === "ENOENT") {
      return true;
    }
  }
  if (error instanceof Error && /\bexit code 127\b/.test(error.message)) {
    return true;
  }
  return false;
}

function sqlScriptPayloadForRunner(script: string): string {
  assertValidSqlScriptUnicode(script);
  return Buffer.from(script, "utf8").toString("utf8");
}

export async function runSqliteScript(dbPath: string, script: string): Promise<void> {
  const scriptWithBusy = `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};\n${script}`;
  const sanitized = sqlScriptPayloadForRunner(scriptWithBusy);
  assertSafeSqlScript(sanitized);
  const execOpts = {
    maxBuffer: 64 * 1024 * 1024,
    timeout: SQLITE_SUBPROCESS_TIMEOUT_MS,
  };
  const py = await resolvePythonInterpreterForSqlite();
  const timeoutSec = Math.ceil(SQLITE_SUBPROCESS_TIMEOUT_MS / 1000);
  const args = [
    ...py.argvPrefix,
    "-c",
    SQLITE_PYTHON_EXECUTESCRIPT,
    dbPath,
    String(timeoutSec),
  ];
  await execFileWithStdinAsync(py.command, args, sanitized, execOpts);
}

/** Run SQL via sqlite3 CLI with -safe -bail and stdin (queries only; no dot-commands). */
export async function runSqliteCliSafeStdin(
  dbPath: string,
  script: string
): Promise<void> {
  assertSafeSqlScript(script);
  await execFileWithStdinAsync(
    "sqlite3",
    sqlite3CliArgs(["-bail", dbPath]),
    script,
    {
      maxBuffer: 64 * 1024 * 1024,
      timeout: SQLITE_SUBPROCESS_TIMEOUT_MS,
    }
  );
}

export function isCommandMissingError(error: unknown, command: string): boolean {
  if (error instanceof SubprocessCommandNotFoundError) {
    const cmd = error.command;
    return cmd === command || subprocessCommandBasename(cmd) === command;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  const lower = msg.toLowerCase();
  const cmdLower = command.toLowerCase();
  if (msg.includes(`spawn ${command} ENOENT`) || msg.includes(`spawn ${command} enoent`)) {
    return true;
  }
  if (msg.includes(`'${command}'`) && (lower.includes("not found") || lower.includes("not recognized"))) {
    return true;
  }
  if (
    lower.includes(cmdLower) &&
    (lower.includes("not recognized as an internal or external command") ||
      lower.includes("is not recognized") ||
      lower.includes("cannot find") ||
      lower.includes("could not find"))
  ) {
    return true;
  }
  if (msg.includes("9009")) {
    return true;
  }
  return false;
}

export function coerceSqliteValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
    }
  }

  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed;
}

export function parseFullJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function parseFullComposerHeadersValue(
  value: unknown
): { allComposers: Array<Record<string, unknown>> } | undefined {
  const parsed = parseFullJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.allComposers)) {
    return undefined;
  }
  return {
    allComposers: obj.allComposers.filter(
      (c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && !Array.isArray(c)
    ),
  };
}

export function filterComposerHeadersByIds(
  headers: { allComposers: Array<Record<string, unknown>> },
  composerIds: ReadonlySet<string>
): { allComposers: Array<Record<string, unknown>> } {
  return {
    allComposers: headers.allComposers.filter((c) => {
      const id = getComposerId(c);
      return id.length > 0 && composerIds.has(id);
    }),
  };
}

export async function listGlobalStateVscdbPaths(
  context?: vscode.ExtensionContext
): Promise<string[]> {
  const syncRoots = resolveExtensionSyncRoots(context);
  const candidates = globalStateVscdbPathsFromRoots(syncRoots);
  const out: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      out.push(candidate);
    } catch {}
  }
  return out;
}

async function listWorkspaceStateVscdbPaths(
  context?: vscode.ExtensionContext
): Promise<string[]> {
  const syncRoots = resolveExtensionSyncRoots(context);
  const storageRoots = workspaceStorageRootsFromCursorUser(syncRoots.cursorUser);
  const out: string[] = [];
  for (const root of storageRoots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, "state.vscdb");
      try {
        await fs.access(p);
        out.push(p);
      } catch {}
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export async function resolveStateDbCandidates(
  context?: vscode.ExtensionContext
): Promise<string[]> {
  const workspaceDbs = await listWorkspaceStateVscdbPaths(context);
  const globalDbs = await listGlobalStateVscdbPaths(context);
  return [...new Set([...workspaceDbs, ...globalDbs])];
}

export async function resolveImportMergeStateDbCandidates(
  context?: vscode.ExtensionContext
): Promise<string[]> {
  const workspaceDbs = await listWorkspaceStateVscdbPaths(context);
  const globalDbs = await listGlobalStateVscdbPaths(context);
  return [...new Set([...globalDbs, ...workspaceDbs])];
}

