import {
  execFile as execFileCallback,
  spawn,
  spawnSync,
  type ExecFileOptions,
} from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

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

const SCRUBBED_ENV_KEYS = [
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^APPDATA$/i,
  /^HOMEDRIVE$/i,
  /^HOMEPATH$/i,
  /^USER$/i,
  /^LOGNAME$/i,
  /^USERNAME$/i,
  /^XDG_/i,
  /^SHELL$/i,
  /^PWD$/i,
  /^OLDPWD$/i,
];

export function subprocessCommandBasename(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (base.endsWith(".exe")) {
    return base.slice(0, -4);
  }
  return base;
}

export function assertAllowedSubprocessCommand(command: string): void {
  const base = subprocessCommandBasename(command);
  if (!ALLOWED_COMMAND_SET.has(base)) {
    throw new Error(
      `Subprocess command not allowlisted: ${command} (allowed: ${ALLOWED_SUBPROCESS_COMMANDS.join(", ")})`
    );
  }
}

export function scrubbedSubprocessEnv(
  extra?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (SCRUBBED_ENV_KEYS.some((re) => re.test(key))) {
      delete env[key];
    }
  }
  return env;
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
  options?: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  assertAllowedSubprocessCommand(file);
  const result = await execFilePromisified(file, args, {
    ...options,
    env: scrubbedSubprocessEnv(options?.env),
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function spawnSyncCapture(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; encoding?: BufferEncoding }
): { status: number | null; stdout: string; stderr: string } {
  assertAllowedSubprocessCommand(command);
  const res = spawnSync(command, args, {
    cwd: options?.cwd,
    encoding: options?.encoding ?? "utf-8",
    env: scrubbedSubprocessEnv(),
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
  assertAllowedSubprocessCommand(command);
  const { args, cwd, log } = options;
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: scrubbedSubprocessEnv(),
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
