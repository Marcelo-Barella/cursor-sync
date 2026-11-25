import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  nodeProcessCwd,
  spawnPython3Capture,
  transportChatSubprocessEnv,
} from "./os-runtime.js";

export type TransportChatScriptName =
  | "cursor_chat_io.py"
  | "cursor_composer_bridge.py";

/** User-global override only; workspace/folder settings cannot redirect Python execution. */
export function getUserTransportChatScriptDir(): string | undefined {
  const inspect = vscode.workspace
    .getConfiguration("cursorSync")
    .inspect<string>("chatImport.transportChatScriptDir");
  const dir = inspect?.globalValue?.trim();
  return dir || undefined;
}

function buildTransportChatScriptCandidates(
  scriptName: TransportChatScriptName,
  extensionPath?: string
): string[] {
  const candidates: string[] = [];
  const overrideDir = getUserTransportChatScriptDir();

  if (overrideDir) {
    candidates.push(path.join(overrideDir, scriptName));
  }

  if (extensionPath) {
    candidates.push(
      path.join(extensionPath, "resources", "transport-chat", "scripts", scriptName)
    );
    candidates.push(path.join(extensionPath, "scripts", scriptName));
    candidates.push(path.join(extensionPath, "..", "scripts", scriptName));
  }
  candidates.push(path.join(nodeProcessCwd(), "scripts", scriptName));
  candidates.push(
    path.join(nodeProcessCwd(), "resources", "transport-chat", "scripts", scriptName)
  );

  return candidates;
}

async function resolveScriptFromCandidates(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return path.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveTransportChatScript(
  scriptName: TransportChatScriptName,
  extensionPath?: string
): Promise<string | null> {
  return resolveScriptFromCandidates(
    buildTransportChatScriptCandidates(scriptName, extensionPath)
  );
}

export async function resolveComposerBridgeScript(
  extensionPath?: string
): Promise<string | null> {
  return resolveTransportChatScript("cursor_composer_bridge.py", extensionPath);
}

export interface RunPythonDiskImportOptions {
  bundlePath: string;
  workspaceFolder: string;
  /** Remap transcript paths to this ~/.cursor/projects folder name. */
  targetProject?: string;
  stateDbPath?: string;
  dryRun?: boolean;
  syncGlobal?: boolean;
  pinRecent?: boolean;
  extensionPath?: string;
  log?: (message: string) => void;
}

export interface RunPythonDiskImportResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runPythonDiskImport(
  options: RunPythonDiskImportOptions
): Promise<RunPythonDiskImportResult> {
  const log = options.log ?? (() => {});
  const scriptPath = await resolveTransportChatScript(
    "cursor_chat_io.py",
    options.extensionPath
  );
  if (!scriptPath) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "transport-chat script not found (cursor_chat_io.py not in extension resources or fallback paths)",
    };
  }

  const args = [
    scriptPath,
    "import",
    options.bundlePath,
    "--workspace-folder",
    options.workspaceFolder,
  ];
  if (options.targetProject?.trim()) {
    args.push("--target-project", options.targetProject.trim());
  }
  if (options.stateDbPath) {
    args.push("--state-db", options.stateDbPath);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.syncGlobal === false) {
    args.push("--no-global-state");
  }
  if (options.pinRecent === false) {
    args.push("--no-pin-recent");
  }

  const { exitCode, stdout, stderr } = await spawnPython3Capture({
    args,
    cwd: options.workspaceFolder,
    env: transportChatSubprocessEnv(),
    log: (line) => log(`chat_io: ${line}`),
  });

  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

export interface RunPythonBundleInspectOptions {
  bundlePath: string;
  extensionPath?: string;
  log?: (message: string) => void;
}

export interface RunPythonBundleInspectResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runPythonBundleInspect(
  options: RunPythonBundleInspectOptions
): Promise<RunPythonBundleInspectResult> {
  const log = options.log ?? (() => {});
  const scriptPath = await resolveTransportChatScript(
    "cursor_chat_io.py",
    options.extensionPath
  );
  if (!scriptPath) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "transport-chat script not found (cursor_chat_io.py not in extension resources or fallback paths)",
    };
  }

  const args = [scriptPath, "inspect", options.bundlePath];
  const { exitCode, stdout, stderr } = await spawnPython3Capture({
    args,
    env: transportChatSubprocessEnv(),
    log: (line) => log(`chat_io inspect: ${line}`),
  });

  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

export interface RunPythonExportDiskKvOptions {
  conversationId: string;
  globalDbPath: string;
  extensionPath?: string;
}

/** Layer 4 export via bundled Python when TS sqlite reads fail on live global state.vscdb. */
export async function runPythonExportDiskKvSnapshot(
  options: RunPythonExportDiskKvOptions
): Promise<import("./chat-disk-kv-export.js").DiskKvSnapshot | null> {
  const scriptPath = await resolveTransportChatScript(
    "cursor_chat_io.py",
    options.extensionPath
  );
  if (!scriptPath) {
    return null;
  }
  const scriptsDir = path.dirname(scriptPath);
  const py = [
    "import json, sys",
    "from pathlib import Path",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from cursor_chat_io_bundle import export_disk_kv_snapshot",
    "db = Path(sys.argv[1])",
    "cid = sys.argv[2]",
    "snap = export_disk_kv_snapshot(db, cid)",
    "print(json.dumps(snap) if snap else 'null')",
  ].join(";");
  const { exitCode, stdout } = await spawnPython3Capture({
    args: ["-c", py, options.globalDbPath, options.conversationId],
    cwd: scriptsDir,
    env: transportChatSubprocessEnv(),
  });
  if (exitCode !== 0) {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      sourceStateDbPath: string;
      rows: Array<{ key: string; value: string; checksum: string }>;
      rowCount: number;
      toolBubbleCount: number;
    };
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      return null;
    }
    return {
      sourceStateDbPath: parsed.sourceStateDbPath,
      rows: parsed.rows,
      rowCount: parsed.rowCount,
      toolBubbleCount: parsed.toolBubbleCount,
    };
  } catch {
    return null;
  }
}
