import { spawn } from "node:child_process";
import * as os from "node:os";

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

function spawnProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export interface SpawnPython3Options {
  args: string[];
  cwd?: string;
  log?: (line: string) => void;
}

export async function spawnPython3Capture(
  options: SpawnPython3Options
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { args, cwd, log } = options;
  return await new Promise((resolve, reject) => {
    const proc = spawn("python3", args, {
      cwd,
      env: spawnProcessEnv(),
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
