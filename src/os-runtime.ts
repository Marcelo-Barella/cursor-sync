import {
  execFile as execFileCallback,
  spawn,
  spawnSync,
  type ExecFileOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { SubprocessCommandNotFoundError } from "./subprocess-errors.js";

const execFilePromisified = promisify(execFileCallback);

/** Subprocess executables the extension may invoke (basename). Documented in docs/app-storage-sync-decisions.md */
export const ALLOWED_SUBPROCESS_COMMANDS: readonly string[] = [
  "python3",
  "python",
  "py",
  "sqlite3",
  "chmod",
];

const ALLOWED_COMMAND_SET = new Set(ALLOWED_SUBPROCESS_COMMANDS);

/** Keys copied from the host process into child environments (nothing else). */
const SUBPROCESS_ENV_ALLOWLIST: readonly string[] = [
  "PATH", // locate allowlisted interpreters on PATH
  "LANG", // locale for Python/sqlite CLI messages
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR", // temp dir hints (not home)
  "TEMP",
  "TMP",
  "SystemRoot", // Windows system root (not user profile)
  "windir",
  "COMSPEC", // Windows cmd for py launcher edge cases
  "PATHEXT", // Windows executable extensions
  "SYSTEMDRIVE",
];

const PYTHON_BASENAME_RE = /^py$|^python$|^python3(\.\d+)*$/i;

let sqlite3SafeFlagSupported: boolean | undefined;

export function subprocessCommandBasename(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (base.endsWith(".exe")) {
    return base.slice(0, -4);
  }
  return base;
}

export function isAllowedSubprocessBasename(basename: string): boolean {
  const base = subprocessCommandBasename(basename);
  if (ALLOWED_COMMAND_SET.has(base)) {
    return true;
  }
  return PYTHON_BASENAME_RE.test(base);
}

export function assertAllowedSubprocessCommand(command: string): void {
  if (!isAllowedSubprocessBasename(subprocessCommandBasename(command))) {
    throw new Error(
      `Subprocess command not allowlisted: ${command} (allowed: ${ALLOWED_SUBPROCESS_COMMANDS.join(", ")}, python3.N)`
    );
  }
}

export function scrubbedSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}

function pathEntriesFromEnv(): string[] {
  const env = scrubbedSubprocessEnv();
  const raw = env.PATH ?? env.Path ?? "";
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && path.isAbsolute(p));
}

function looksRelativeCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, "/");
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return true;
  }
  if (!path.isAbsolute(command) && (normalized.includes("/") || normalized.includes("\\"))) {
    return true;
  }
  return false;
}

function resolveOnPath(basename: string, pathDirs: string[]): string | undefined {
  const extensions =
    process.platform === "win32"
      ? (scrubbedSubprocessEnv().PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, basename + ext);
      try {
        if (fs.existsSync(candidate)) {
          return path.resolve(candidate);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/**
 * Resolve an allowlisted command to an absolute executable path using PATH from scrubbed env (never cwd).
 */
export function resolveSubprocessCommand(command: string): string {
  assertAllowedSubprocessCommand(command);
  const trimmed = command.trim();
  if (looksRelativeCommand(trimmed)) {
    throw new Error(`Subprocess command must not be a relative path: ${command}`);
  }
  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) {
      throw new SubprocessCommandNotFoundError(command);
    }
    const base = subprocessCommandBasename(resolved);
    if (!isAllowedSubprocessBasename(base)) {
      throw new Error(`Subprocess command not allowlisted: ${command}`);
    }
    return resolved;
  }
  const base = subprocessCommandBasename(trimmed);
  const resolved = resolveOnPath(base, pathEntriesFromEnv());
  if (!resolved) {
    throw new SubprocessCommandNotFoundError(command);
  }
  return resolved;
}

function validateSubprocessCwd(cwd: string | URL | undefined): string | undefined {
  if (cwd === undefined) {
    return undefined;
  }
  if (typeof cwd !== "string") {
    throw new Error("Subprocess cwd must be a string path");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Subprocess cwd must be absolute: ${cwd}`);
  }
  const normalized = path.resolve(cwd);
  if (normalized.split(/[/\\]/).includes("..")) {
    throw new Error(`Subprocess cwd must not contain .. segments: ${cwd}`);
  }
  return normalized;
}

type SafeExecFileOptions = Pick<
  ExecFileOptions,
  "cwd" | "maxBuffer" | "timeout" | "encoding"
> & {
  input?: string | Buffer;
};

function safeExecOptions(options?: SafeExecFileOptions): ExecFileOptions {
  return {
    cwd: validateSubprocessCwd(options?.cwd),
    maxBuffer: options?.maxBuffer,
    timeout: options?.timeout,
    encoding: options?.encoding,
    shell: false,
    env: scrubbedSubprocessEnv(),
  };
}

export async function execFileWithStdinAsync(
  file: string,
  args: readonly string[],
  stdin: string | Buffer,
  options?: SafeExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveSubprocessCommand(file);
  const safe = safeExecOptions(options);
  return await new Promise((resolve, reject) => {
    const proc = spawn(resolved, args, {
      cwd: safe.cwd,
      env: safe.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutAcc = "";
    let stderrAcc = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (c) => {
      stdoutAcc += String(c);
    });
    proc.stderr?.on("data", (c) => {
      stderrAcc += String(c);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdoutAcc, stderr: stderrAcc });
      } else {
        reject(
          Object.assign(new Error(`Command failed with exit code ${code ?? 1}`), {
            code,
            stdout: stdoutAcc,
            stderr: stderrAcc,
          })
        );
      }
    });
    proc.stdin?.write(stdin);
    proc.stdin?.end();
  });
}

/** @internal test hook for subprocess option hardening */
export function subprocessExecFileOptionsForTest(
  options?: SafeExecFileOptions & { shell?: boolean; env?: NodeJS.ProcessEnv }
): ExecFileOptions {
  return safeExecOptions(options);
}

export function systemTmpDir(): string {
  return os.tmpdir();
}

export function deviceIdentitySalt(): string {
  return `${os.hostname()}:${os.userInfo().username}`;
}

export function nodePlatform(): NodeJS.Platform {
  return process.platform;
}

export function isWin32Platform(): boolean {
  return nodePlatform() === "win32";
}

export function nodeProcessPid(): number {
  return process.pid;
}

export function nodeProcessArgv(): string[] {
  return process.argv;
}

export function nodeProcessCwd(): string {
  return process.cwd();
}

export interface SpawnPython3Options {
  args: string[];
  cwd?: string;
  log?: (line: string) => void;
  /** Override interpreter (must still be allowlisted basename). */
  command?: string;
}

export async function execFileAsync(
  file: string,
  args: readonly string[],
  options?: SafeExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const resolved = resolveSubprocessCommand(file);
  const result = await execFilePromisified(resolved, args, safeExecOptions(options));
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function spawnSyncCapture(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; encoding?: BufferEncoding }
): { status: number | null; stdout: string; stderr: string } {
  const resolved = resolveSubprocessCommand(command);
  const finalArgs =
    subprocessCommandBasename(command) === "sqlite3"
      ? sqlite3CliArgs(args)
      : [...args];
  const res = spawnSync(resolved, finalArgs, {
    cwd: validateSubprocessCwd(options?.cwd),
    encoding: options?.encoding ?? "utf-8",
    env: scrubbedSubprocessEnv(),
    shell: false,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

export async function spawnPython3Capture(
  options: SpawnPython3Options
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = options.command ?? "python3";
  const resolved = resolveSubprocessCommand(command);
  const { args, cwd, log } = options;
  return await new Promise((resolve, reject) => {
    const proc = spawn(resolved, args, {
      cwd: validateSubprocessCwd(cwd),
      env: scrubbedSubprocessEnv(),
      shell: false,
    });
    let stdoutAcc = "";
    let stderrAcc = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutAcc += String(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrAcc += String(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      for (const line of stderrAcc.trim().split("\n")) {
        if (line.trim()) {
          log?.(line);
        }
      }
      for (const line of stdoutAcc.trim().split("\n")) {
        if (line.trim()) {
          log?.(line);
        }
      }
      resolve({ exitCode: code ?? 1, stdout: stdoutAcc, stderr: stderrAcc });
    });
  });
}

function sqlite3SupportsSafeFlag(): boolean {
  if (sqlite3SafeFlagSupported !== undefined) {
    return sqlite3SafeFlagSupported;
  }
  try {
    const resolved = resolveSubprocessCommand("sqlite3");
    const res = spawnSync(resolved, ["-safe", "-version"], {
      env: scrubbedSubprocessEnv(),
      encoding: "utf-8",
      shell: false,
    });
    sqlite3SafeFlagSupported = res.status === 0;
  } catch {
    sqlite3SafeFlagSupported = false;
  }
  if (!sqlite3SafeFlagSupported) {
    void import("./diagnostics.js")
      .then(({ getLogger }) => {
        getLogger().appendLine(
          `[${new Date().toISOString()}] sqlite3 CLI does not support -safe; using fallback without -safe (documented residual risk)`
        );
      })
      .catch(() => {
        /* extension not activated */
      });
  }
  return sqlite3SafeFlagSupported;
}

/** Prefix sqlite3 CLI args with -safe when supported (.shell / .system disabled). */
export function sqlite3CliArgs(userArgs: readonly string[]): string[] {
  if (sqlite3SupportsSafeFlag()) {
    return ["-safe", ...userArgs];
  }
  return [...userArgs];
}

export function isSqlite3SafeModeCliError(error: unknown): boolean {
  const msg =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message)
      : String(error);
  return /safe mode/i.test(msg);
}
