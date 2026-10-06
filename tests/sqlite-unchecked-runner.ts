import { execFileWithStdinAsync } from "../src/os-runtime.js";
import { SQLITE_PYTHON_EXECUTESCRIPT } from "../src/sqlite-script-safety.js";
import {
  resolvePythonInterpreterForSqlite,
  SQLITE_SUBPROCESS_TIMEOUT_MS,
} from "../src/transcripts-sqlite.js";

/** Test-only unchecked SQLite executescript (same argv/stdin as production runner). */
export async function runSqlitePythonExecutescriptUnchecked(
  dbPath: string,
  script: string
): Promise<void> {
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
  await execFileWithStdinAsync(py.command, args, script, execOpts);
}
