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
  assertReadOnlySqliteQuery,
  assertSafeSqlScript,
  assertValidSqlScriptUnicode,
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

const SQLITE_PYTHON_EXECUTESCRIPT = [
  "import re, sqlite3, sys, unicodedata",
  "db_path = sys.argv[1]",
  "sql = sys.stdin.read()",
  `timeout = int(sys.argv[2]) if len(sys.argv) > 2 else ${20}`,
  "ALLOWED_PRAGMAS = frozenset({",
  '    "busy_timeout", "wal_checkpoint", "user_version", "encoding",',
  '    "foreign_keys", "journal_mode", "synchronous", "temp_store",',
  "})",
  "FORBIDDEN_FUNCS = frozenset({",
  '    "load_extension", "writefile", "readfile", "edit", "fts3_tokenizer",',
  "})",
  "FORBIDDEN_STMT = re.compile(",
  '    r"\\b(attach|detach|vacuum)\\b", re.I',
  ")",
  "FORBIDDEN_CALL = re.compile(",
  '    r"\\b(load_extension|writefile|readfile|edit|fts3_tokenizer)\\s*\\(", re.I',
  ")",
  "ALLOWED_AUTHORIZER_ACTIONS = frozenset({",
  "    sqlite3.SQLITE_SELECT,",
  "    sqlite3.SQLITE_READ,",
  "    sqlite3.SQLITE_INSERT,",
  "    sqlite3.SQLITE_UPDATE,",
  "    sqlite3.SQLITE_DELETE,",
  "    sqlite3.SQLITE_TRANSACTION,",
  "    sqlite3.SQLITE_SAVEPOINT,",
  "    sqlite3.SQLITE_FUNCTION,",
  "    sqlite3.SQLITE_PRAGMA,",
  "})",
  "",
  "def _is_cf(ch):",
  "    return len(ch) == 1 and unicodedata.category(ch) == 'Cf'",
  "",
  "def _reject_outside_single_quoted(ch):",
  "    if len(ch) != 1:",
  "        return",
  "    if ord(ch) > 0x7f or _is_cf(ch):",
  "        raise sqlite3.OperationalError('non-ascii outside string literal')",
  "",
  "def _is_ws(ch):",
  "    return ch in ' \\t\\n\\f\\r'",
  "",
  "def _authorizer(action, p1, p2, dbname, trigger):",
  "    if action not in ALLOWED_AUTHORIZER_ACTIONS:",
  "        return sqlite3.SQLITE_DENY",
  "    if action == sqlite3.SQLITE_PRAGMA:",
  "        name = (p1 or '').split('(')[0].strip().lower()",
  "        if name not in ALLOWED_PRAGMAS:",
  "            return sqlite3.SQLITE_DENY",
  "    if action == sqlite3.SQLITE_FUNCTION:",
  "        fname = (p2 or '').lower()",
  "        if fname in FORBIDDEN_FUNCS:",
  "            return sqlite3.SQLITE_DENY",
  "    return sqlite3.SQLITE_OK",
  "",
  "def _split_statements(script):",
  "    out = []",
  "    buf = []",
  "    state = 'n'",
  "    i = 0",
  "    while i < len(script):",
  "        ch = script[i]",
  "        nxt = script[i + 1] if i + 1 < len(script) else ''",
  "        if state == 'n':",
  "            _reject_outside_single_quoted(ch)",
  "            if _is_ws(ch):",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == '-' and nxt == '-':",
  "                i += 2",
  "                while i < len(script) and script[i] != '\\n':",
  "                    i += 1",
  "                continue",
  "            if ch == '/' and nxt == '*':",
  "                i += 2",
  "                while i < len(script):",
  "                    if script[i] == '*' and i + 1 < len(script) and script[i + 1] == '/':",
  "                        i += 2",
  "                        break",
  "                    i += 1",
  "                else:",
  "                    i = len(script)",
  "                continue",
  "            if ch == \"'\":",
  "                state = 's'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch in 'Xx' and nxt == \"'\":",
  "                state = 'b'",
  "                buf.append(ch)",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'd'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == '`':",
  "                state = 't'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == '[':",
  "                state = 'k'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == ';':",
  "                stmt = ''.join(buf).strip()",
  "                if stmt:",
  "                    out.append(stmt)",
  "                buf = []",
  "                i += 1",
  "                continue",
  "            buf.append(ch)",
  "            i += 1",
  "            continue",
  "        if state == 's':",
  "            buf.append(ch)",
  "            if ch == \"'\" and nxt == \"'\":",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == \"'\":",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'b':",
  "            buf.append(ch)",
  "            if ch == \"'\":",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'd':",
  "            _reject_outside_single_quoted(ch)",
  "            buf.append(ch)",
  "            if ch == '\"' and nxt == '\"':",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 't':",
  "            _reject_outside_single_quoted(ch)",
  "            buf.append(ch)",
  "            if ch == '`' and nxt == '`':",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '`':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'k':",
  "            _reject_outside_single_quoted(ch)",
  "            buf.append(ch)",
  "            if ch == ']':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "    tail = ''.join(buf).strip()",
  "    if tail:",
  "        out.append(tail)",
  "    return out",
  "",
  "def _security_surface(stmt):",
  "    surface = []",
  "    state = 'n'",
  "    word = []",
  "    prev_end = 0",
  "    i = 0",
  "    while i < len(stmt):",
  "        ch = stmt[i]",
  "        nxt = stmt[i + 1] if i + 1 < len(stmt) else ''",
  "        if state == 'n':",
  "            _reject_outside_single_quoted(ch)",
  "            if _is_ws(ch):",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                i += 1",
  "                continue",
  "            if ch == '-' and nxt == '-':",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                i += 2",
  "                while i < len(stmt) and stmt[i] != '\\n':",
  "                    i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch == '/' and nxt == '*':",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                i += 2",
  "                while i < len(stmt):",
  "                    if stmt[i] == '*' and i + 1 < len(stmt) and stmt[i + 1] == '/':",
  "                        i += 2",
  "                        break",
  "                    i += 1",
  "                else:",
  "                    i = len(stmt)",
  "                prev_end = i",
  "                continue",
  "            if ch == \"'\":",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                if prev_end < i and surface and re.search(r'[ \\t\\n\\f\\r]', stmt[prev_end:i]):",
  "                    surface.append(' ')",
  "                surface.append(' ')",
  "                state = 's'",
  "                i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch in 'Xx' and nxt == \"'\":",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                surface.append(' ')",
  "                state = 'b'",
  "                i += 2",
  "                prev_end = i",
  "                continue",
  "            if ch in ('\"', '`', '['):",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                if prev_end < i and surface and re.search(r'[ \\t\\n\\f\\r]', stmt[prev_end:i]):",
  "                    surface.append(' ')",
  "                surface.append(' ')",
  "                state = 'd' if ch == '\"' else ('t' if ch == '`' else 'k')",
  "                i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch.isascii() and (ch.isalnum() or ch == '_'):",
  "                if prev_end < i and word and re.search(r'[ \\t\\n\\f\\r]', stmt[prev_end:i]):",
  "                    surface.append(''.join(word))",
  "                    surface.append(' ')",
  "                    word = []",
  "                if not word:",
  "                    word = [ch]",
  "                else:",
  "                    word.append(ch)",
  "                i += 1",
  "                continue",
  "            if word:",
  "                surface.append(''.join(word))",
  "                word = []",
  "            surface.append(ch)",
  "            i += 1",
  "            prev_end = i",
  "            continue",
  "        if state == 's':",
  "            if ch == \"'\" and nxt == \"'\":",
  "                i += 2",
  "                continue",
  "            if ch == \"'\":",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'b':",
  "            if ch == \"'\":",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'd':",
  "            _reject_outside_single_quoted(ch)",
  "            if ch == '\"' and nxt == '\"':",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 't':",
  "            _reject_outside_single_quoted(ch)",
  "            if ch == '`' and nxt == '`':",
  "                i += 2",
  "                continue",
  "            if ch == '`':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'k':",
  "            _reject_outside_single_quoted(ch)",
  "            if ch == ']':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "    if word:",
  "        surface.append(''.join(word))",
  "    return re.sub(r'[ \\t\\n\\f\\r]+', ' ', ''.join(surface)).strip()",
  "",
  "def _refuse_unsafe_statement(stmt):",
  "    surface = _security_surface(stmt)",
  "    if FORBIDDEN_STMT.search(surface) or FORBIDDEN_CALL.search(surface):",
  "        raise sqlite3.OperationalError('refused unsafe SQL statement')",
  "",
  "conn = sqlite3.connect(db_path, timeout=timeout)",
  "conn.enable_load_extension(False)",
  "conn.set_authorizer(_authorizer)",
  "if hasattr(sqlite3, 'SQLITE_LIMIT_ATTACHED'):",
  "    conn.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)",
  "try:",
  "    for stmt in _split_statements(sql):",
  "        _refuse_unsafe_statement(stmt)",
  "        conn.execute(stmt)",
  "    conn.commit()",
  "finally:",
  "    conn.close()",
].join("\n");

export const SQLITE_PYTHON_FALLBACK_SCRIPT = [
  "import json, sqlite3, sys, urllib.parse",
  "db_path = sys.argv[1]",
  "sql = sys.argv[2]",
  "uri_path = urllib.parse.quote(db_path, safe='/')",
  `conn = sqlite3.connect(f'file:{uri_path}?mode=ro', uri=True, timeout=${Math.ceil(SQLITE_SUBPROCESS_TIMEOUT_MS / 1000)})`,
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

async function resolvePythonInterpreterForSqlite(): Promise<PythonSqliteInterpreter> {
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
  assertReadOnlySqliteQuery(sql);
  const execOpts = { maxBuffer: 64 * 1024 * 1024, timeout: SQLITE_SUBPROCESS_TIMEOUT_MS };
  if (await preferPythonForDbFile(dbPath)) {
    return runPythonSqliteQuery(dbPath, sql, execOpts);
  }
  try {
    return await execFileAsync(
      "sqlite3",
      sqlite3CliArgs(["-readonly", "-json", dbPath, sql]),
      execOpts
    );
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

