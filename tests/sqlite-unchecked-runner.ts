import {
  execFileAsync,
  execFileWithStdinAsync,
  isWin32Platform,
} from "../src/os-runtime.js";
import { SQLITE_PYTHON_EXECUTESCRIPT } from "./fixtures/sqlite-python-executescript-constant.js";
import { SQLITE_SUBPROCESS_TIMEOUT_MS } from "../src/transcripts-sqlite.js";

type PythonSqliteInterpreter = {
  command: string;
  argvPrefix: readonly string[];
};

async function resolvePythonInterpreterForSqliteTests(): Promise<PythonSqliteInterpreter> {
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
  throw new Error("No Python with sqlite3 for tests");
}

/** Test-only unchecked SQLite executescript (same argv/stdin as production runner). */
export async function runSqlitePythonExecutescriptUnchecked(
  dbPath: string,
  script: string
): Promise<void> {
  const execOpts = {
    maxBuffer: 64 * 1024 * 1024,
    timeout: SQLITE_SUBPROCESS_TIMEOUT_MS,
  };
  const py = await resolvePythonInterpreterForSqliteTests();
  const timeoutSec = Math.ceil(SQLITE_SUBPROCESS_TIMEOUT_MS / 1000);
  const args = [
    ...py.argvPrefix,
    "-c",
    SQLITE_PYTHON_EXECUTESCRIPT,
    dbPath,
    String(timeoutSec),
  ];
  await execFileWithStdinAsync(py.command, args, script, execOpts);
}
