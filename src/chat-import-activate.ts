import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatBundle } from "./chat-persistence.js";
import {
  applyRichComposerEntryToPartialState,
  bundleToPartialState,
  partialStateForCreateNewCommand,
  partialStateHasConversationContent,
  partialStateSafeForCreateNew,
  type PartialState,
} from "./chat-partial-state.js";
import {
  readRichComposerDataEntryFromStateDb,
  repairComposerDataAfterActivation,
} from "./chat-import-merge.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { stateDbPathForWorkspaceStorageId } from "./chat-workspace-context.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import { resolveComposerBridgeScript } from "./chat-transport-scripts.js";

export const CREATE_NEW_COMPOSER_COMMAND_ID = "composer.createNew";
export const CREATE_COMPOSER_COMMAND_ID = "composer.createComposer";
export const COMPOSER_GET_HANDLE_COMMAND_ID = "composer.getComposerHandleById";
export const OPEN_COMPOSER_COMMAND_ID = "composer.openComposer";
export const FOCUS_COMPOSER_COMMAND_ID = "composer.focusComposer";
export const COMPOSER_URI_SCHEME = "cursor.composer";
export const MANIFEST_VERSION = 1;

export const ACTIVATION_DIR = path.join(os.homedir(), ".cursor", "import-activation");
export const ACTIVATION_PENDING_PATH = path.join(ACTIVATION_DIR, "pending.json");
export const ACTIVATION_RESULT_PATH = path.join(ACTIVATION_DIR, "result.json");

export interface ActivationPaths {
  activationDir: string;
  pendingPath: string;
  resultPath: string;
}

export interface ActivationResult {
  ok: boolean;
  composerId?: string;
}

export interface ComposerActivationOutcome {
  ok: boolean;
  composerId?: string;
  exitCode: number;
  stagedOnly: boolean;
}

export interface RunComposerActivationOptions {
  paths?: ActivationPaths;
  waitResultMs?: number;
  /** When false, do not write ~/.cursor/import-activation/pending.json (sidebar Open). */
  stagePending?: boolean;
  /** When true, composer.openComposer without a handle still counts as success (store.db on disk). */
  acceptOpenWithoutHandle?: boolean;
  handlePreloadTimeoutMs?: number;
  handlePostOpenTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface RunPythonComposerBridgeOptions {
  paths?: ActivationPaths;
  waitResultMs?: number;
  dryRun?: boolean;
  bridgeScriptPath?: string | null;
  extensionPath?: string;
  log?: (message: string) => void;
}

export interface RunPostImportActivationOptions {
  paths?: ActivationPaths;
  activateStrict?: boolean;
  bridgeWaitResultMs?: number;
  dryRun?: boolean;
  extensionPath?: string;
  openInNewTab?: boolean;
  /** When true (default inside Cursor Sync), never spawn the Python bridge; IDE only. */
  skipPythonBridge?: boolean;
  log?: (message: string) => void;
}

export interface WaitForActivationResultOptions {
  paths?: ActivationPaths;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RawActivationManifest {
  partialState: PartialState | Record<string, unknown>;
  workspaceFolder: string;
  openInNewTab?: boolean;
  createComposerOptions?: Record<string, unknown>;
}

export interface ActivationManifest {
  version: number;
  composerId: string;
  partialState: PartialState | Record<string, unknown>;
  workspaceFolder: string;
  openInNewTab: boolean;
  createComposerOptions: Record<string, unknown>;
  commandId: string;
  stagedAt: string;
}

export function defaultActivationPaths(): ActivationPaths {
  const activationDir = path.join(os.homedir(), ".cursor", "import-activation");
  return {
    activationDir,
    pendingPath: path.join(activationDir, "pending.json"),
    resultPath: path.join(activationDir, "result.json"),
  };
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

function composerIdFromPartial(partial: Record<string, unknown>): string {
  const cid = partial.composerId;
  if (typeof cid !== "string" || !cid.trim()) {
    throw new Error("partialState.composerId is required");
  }
  return cid.trim();
}

export function buildActivationManifest(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string,
  workspaceCtx: WorkspaceContext,
  options: { openInNewTab?: boolean } = {}
): RawActivationManifest {
  const openInNewTab = options.openInNewTab ?? true;
  const partial = bundleToPartialState(bundle, conversationId, {
    workspaceIdentifier: workspaceCtx.workspaceIdentifier,
  });
  return {
    partialState: partial,
    workspaceFolder: workspaceCtx.folderFsPath,
    openInNewTab,
  };
}

export function normalizeActivationManifest(
  raw: Record<string, unknown>
): ActivationManifest {
  const partial = raw.partialState;
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
    throw new Error("manifest.partialState object is required");
  }

  const workspaceFolderRaw = raw.workspaceFolder;
  if (
    typeof workspaceFolderRaw !== "string" ||
    !workspaceFolderRaw.trim()
  ) {
    throw new Error("manifest.workspaceFolder (absolute path) is required");
  }
  let folder = workspaceFolderRaw.trim();
  if (folder === "~") {
    folder = os.homedir();
  } else if (folder.startsWith("~/")) {
    folder = path.join(os.homedir(), folder.slice(2));
  }
  const workspaceFolder = path.resolve(folder);

  let openInNewTab = raw.openInNewTab;
  if (openInNewTab === undefined || openInNewTab === null) {
    openInNewTab = true;
  }
  if (typeof openInNewTab !== "boolean") {
    throw new Error("manifest.openInNewTab must be a boolean");
  }

  const composerId = composerIdFromPartial(partial as Record<string, unknown>);

  let createComposerOptions: Record<string, unknown>;
  const rawOptions = raw.createComposerOptions;
  if (rawOptions === undefined || rawOptions === null) {
    createComposerOptions = { openInNewTab, view: "editor" };
  } else if (typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Error("manifest.createComposerOptions must be an object when set");
  } else {
    createComposerOptions = { ...(rawOptions as Record<string, unknown>) };
    if (!("openInNewTab" in createComposerOptions)) {
      createComposerOptions.openInNewTab = openInNewTab;
    }
  }

  return {
    version: MANIFEST_VERSION,
    composerId,
    partialState: partial as PartialState,
    workspaceFolder,
    openInNewTab,
    createComposerOptions,
    commandId: CREATE_COMPOSER_COMMAND_ID,
    stagedAt: utcNowIso(),
  };
}

export async function stagePendingManifest(
  manifest: ActivationManifest,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<string> {
  await fs.mkdir(paths.activationDir, { recursive: true });
  const tmpPath = `${paths.pendingPath}.tmp`;
  const payload = JSON.stringify(manifest, null, 2) + "\n";
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, paths.pendingPath);
  return paths.pendingPath;
}

export async function writeResultJson(
  composerId: string,
  ok = true,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  await fs.mkdir(paths.activationDir, { recursive: true });
  const payload: ActivationResult = {
    ok,
    composerId: composerId.trim(),
  };
  await fs.writeFile(
    paths.resultPath,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );
}

export async function clearStaleResult(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  try {
    await fs.unlink(paths.resultPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export function parseComposerIdFromCommandResult(
  result: unknown,
  fallbackComposerId: string
): string {
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const cid = (result as Record<string, unknown>).composerId;
    if (typeof cid === "string" && cid.trim()) {
      return cid.trim();
    }
  }
  return fallbackComposerId.trim();
}

export async function composerCommandAvailable(
  commandId: string = CREATE_COMPOSER_COMMAND_ID
): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  return commands.includes(commandId);
}

function activationManifestFingerprint(manifest: ActivationManifest): string {
  return JSON.stringify({
    composerId: manifest.composerId,
    workspaceFolder: manifest.workspaceFolder,
    commandId: manifest.commandId,
    partialState: manifest.partialState,
    createComposerOptions: manifest.createComposerOptions,
  });
}

export async function pendingManifestMatches(
  manifest: ActivationManifest,
  paths: ActivationPaths = defaultActivationPaths()
): Promise<boolean> {
  try {
    const text = await fs.readFile(paths.pendingPath, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    const onDisk = normalizeActivationManifest(raw);
    return activationManifestFingerprint(onDisk) === activationManifestFingerprint(manifest);
  } catch {
    return false;
  }
}

export async function archiveFailedPending(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<void> {
  const failedPath = `${paths.pendingPath}.failed`;
  try {
    await fs.rename(paths.pendingPath, failedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export function composerUriForId(composerId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: COMPOSER_URI_SCHEME, path: composerId.trim() });
}

async function fetchComposerHandle(composerId: string): Promise<unknown> {
  return vscode.commands.executeCommand(COMPOSER_GET_HANDLE_COMMAND_ID, composerId);
}

function hasComposerHandle(handle: unknown): boolean {
  return handle !== undefined && handle !== null;
}

export async function waitForComposerHandle(
  composerId: string,
  options: { timeoutMs?: number; pollMs?: number; log?: (message: string) => void } = {}
): Promise<unknown> {
  const log = options.log ?? (() => {});
  if (!(await composerCommandAvailable(COMPOSER_GET_HANDLE_COMMAND_ID))) {
    return undefined;
  }
  const timeoutMs = Math.max(0, options.timeoutMs ?? 8000);
  const pollMs = Math.max(50, options.pollMs ?? 250);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await fetchComposerHandle(composerId);
      if (hasComposerHandle(handle)) {
        return handle;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`waitForComposerHandle: ${message}`);
    }
    await delayMs(pollMs);
  }
  return undefined;
}

export async function enrichManifestPartialStateFromDisk(
  manifest: ActivationManifest,
  workspaceStorageId: string
): Promise<boolean> {
  const partial = manifest.partialState as Record<string, unknown>;
  if (partialStateHasConversationContent(partial)) {
    return false;
  }
  const { cursorUser } = resolveExtensionSyncRoots();
  const dbPaths = [
    stateDbPathForWorkspaceStorageId(workspaceStorageId),
    path.join(cursorUser, "globalStorage", "state.vscdb"),
  ];
  for (const dbPath of dbPaths) {
    const rich = await readRichComposerDataEntryFromStateDb(dbPath, manifest.composerId);
    if (!rich) {
      continue;
    }
    const targetWorkspaceIdentifier = partial.workspaceIdentifier;
    const targetName = partial.name;
    const nowMs = Date.now();
    applyRichComposerEntryToPartialState(
      partial as PartialState,
      rich,
      manifest.composerId
    );
    if (
      targetWorkspaceIdentifier &&
      typeof targetWorkspaceIdentifier === "object" &&
      !Array.isArray(targetWorkspaceIdentifier)
    ) {
      partial.workspaceIdentifier = targetWorkspaceIdentifier;
    }
    if (typeof targetName === "string" && targetName.trim()) {
      partial.name = targetName;
    }
    partial.createdAt = nowMs;
    partial.lastUpdatedAt = nowMs;
    partial.lastOpenedAt = nowMs;
    partial.conversationCheckpointLastUpdatedAt = nowMs;
    const headers = partial.fullConversationHeadersOnly;
    if (Array.isArray(headers)) {
      partial.fullConversationHeadersOnly = headers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return entry;
        }
        const rec = entry as Record<string, unknown>;
        if (rec.composerId !== manifest.composerId) {
          return entry;
        }
        return {
          ...rec,
          workspaceIdentifier: partial.workspaceIdentifier,
          createdAt: nowMs,
          lastUpdatedAt: nowMs,
          lastOpenedAt: nowMs,
          conversationCheckpointLastUpdatedAt: nowMs,
        };
      });
    }
    return true;
  }
  return false;
}

async function tryRegisterViaCreateNew(
  manifest: ActivationManifest,
  paths: ActivationPaths,
  log: (message: string) => void
): Promise<ComposerActivationOutcome | null> {
  if (!(await composerCommandAvailable(CREATE_NEW_COMPOSER_COMMAND_ID))) {
    return null;
  }
  const partial = manifest.partialState as Record<string, unknown>;
  const safeForCreateNew = partialStateSafeForCreateNew(partial);
  if (!safeForCreateNew) {
    return null;
  }
  const createNewPartial = partialStateForCreateNewCommand(partial);
  const options: Record<string, unknown> = {
    composerId: manifest.composerId,
    partialState: createNewPartial,
    workspaceFolder: manifest.workspaceFolder,
    ...manifest.createComposerOptions,
  };
  try {
    const commandResult = await vscode.commands.executeCommand(
      CREATE_NEW_COMPOSER_COMMAND_ID,
      options
    );
    const composerId = parseComposerIdFromCommandResult(commandResult, manifest.composerId);
    if (composerId !== manifest.composerId) {
      throw new Error(
        `composer.createNew returned composerId=${composerId}, expected ${manifest.composerId}`
      );
    }
    await writeResultJson(composerId, true, paths);
    log(`composer.createNew succeeded: composerId=${composerId}`);
    return {
      ok: true,
      composerId,
      exitCode: 0,
      stagedOnly: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`composer.createNew failed: ${message}`);
    return {
      ok: false,
      exitCode: 1,
      stagedOnly: false,
    };
  }
}

async function tryOpenViaComposerCommands(
  manifest: ActivationManifest,
  log: (message: string) => void
): Promise<boolean> {
  const openAvailable = await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID);
  const focusAvailable = await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID);
  const openOpts = {
    openInNewTab: manifest.openInNewTab,
    view: manifest.createComposerOptions.view ?? "editor",
    openExistingOnly: true,
  };

  if (openAvailable) {
    try {
      await vscode.commands.executeCommand(
        OPEN_COMPOSER_COMMAND_ID,
        manifest.composerId,
        openOpts
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.openComposer failed: ${message}`);
      try {
        await vscode.commands.executeCommand(
          OPEN_COMPOSER_COMMAND_ID,
          manifest.composerId
        );
        return true;
      } catch (err2) {
        const message2 = err2 instanceof Error ? err2.message : String(err2);
        log(`composer.openComposer (id only) failed: ${message2}`);
      }
    }
  }

  if (focusAvailable) {
    try {
      await vscode.commands.executeCommand(
        FOCUS_COMPOSER_COMMAND_ID,
        manifest.composerId
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.focusComposer failed: ${message}`);
    }
  }

  return false;
}

export async function tryActivateViaComposerHandle(
  manifest: ActivationManifest,
  options: RunComposerActivationOptions = {}
): Promise<ComposerActivationOutcome | null> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});

  const handleCmdAvailable = await composerCommandAvailable(
    COMPOSER_GET_HANDLE_COMMAND_ID
  );
  if (!(await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID)) &&
    !(await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID)) &&
    !handleCmdAvailable) {
    return null;
  }

  const preloadMs = Math.max(0, options.handlePreloadTimeoutMs ?? 6000);
  const postOpenMs = Math.max(0, options.handlePostOpenTimeoutMs ?? 4000);
  await waitForComposerHandle(manifest.composerId, {
    timeoutMs: preloadMs,
    pollMs: 250,
    log,
  });

  if (await tryOpenViaComposerCommands(manifest, log)) {
    const handle = await waitForComposerHandle(manifest.composerId, {
      timeoutMs: postOpenMs,
      pollMs: 200,
      log,
    });
    if (hasComposerHandle(handle)) {
      await writeResultJson(manifest.composerId, true, paths);
      log(`Activation OK (composer.openComposer+loaded): composerId=${manifest.composerId}`);
      return {
        ok: true,
        composerId: manifest.composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }
    if (options.acceptOpenWithoutHandle) {
      await writeResultJson(manifest.composerId, true, paths);
      log(
        `Activation OK (composer.openComposer, no handle; store on disk): composerId=${manifest.composerId}`
      );
      return {
        ok: true,
        composerId: manifest.composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }
    log(
      `composer.openComposer ran but conversation did not load for composerId=${manifest.composerId}; try Reload Window`
    );
  }

  if (!handleCmdAvailable) {
    return null;
  }

  let handle: unknown;
  try {
    handle = await fetchComposerHandle(manifest.composerId);
  } catch (handleErr) {
    const handleMessage =
      handleErr instanceof Error ? handleErr.message : String(handleErr);
    log(`composer handle activation failed: ${handleMessage}`);
    return null;
  }

  if (hasComposerHandle(handle)) {
    await writeResultJson(manifest.composerId, true, paths);
    log(`Activation OK (handle loaded): composerId=${manifest.composerId}`);
    return {
      ok: true,
      composerId: manifest.composerId,
      exitCode: 0,
      stagedOnly: false,
    };
  }

  log(
    `composer.getComposerHandleById returned no handle for composerId=${manifest.composerId} ` +
      "(store.db may be missing under ~/.cursor/chats/<workspace-key>/)"
  );
  return null;
}

export async function readActivationResult(
  paths: ActivationPaths = defaultActivationPaths()
): Promise<ActivationResult | null> {
  try {
    const text = await fs.readFile(paths.resultPath, "utf8");
    const data = JSON.parse(text) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const rec = data as Record<string, unknown>;
    if (rec.ok === false) {
      return null;
    }
    const cid = rec.composerId;
    if (typeof cid === "string" && cid.trim()) {
      return { ok: true, composerId: cid.trim() };
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForActivationResult(
  options: WaitForActivationResultOptions = {}
): Promise<string | null> {
  const paths = options.paths ?? defaultActivationPaths();
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);

  if (timeoutMs === 0) {
    const one = await readActivationResult(paths);
    return one?.composerId ?? null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readActivationResult(paths);
    if (result?.composerId) {
      return result.composerId;
    }
    await delayMs(pollIntervalMs);
  }
  return null;
}

export function pingServerProbe(
  conversationId: string,
  log: (message: string) => void = () => {}
): void {
  log(
    `note: --ping-server probe not implemented for ${conversationId} ` +
      "(no agentClient HTTP contract in v1; see activation-architecture.md)"
  );
}

export { resolveComposerBridgeScript };

export function parseBridgeStdout(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row) {
      continue;
    }
    try {
      const data = JSON.parse(row) as Record<string, unknown>;
      const cid = data.composerId;
      if (typeof cid === "string" && cid.trim()) {
        return cid.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function runPythonComposerBridge(
  rawManifest: RawActivationManifest,
  options: RunPythonComposerBridgeOptions = {}
): Promise<ComposerActivationOutcome> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});
  const waitResultMs = Math.max(0, options.waitResultMs ?? 0);
  const partial = rawManifest.partialState as Record<string, unknown>;
  const fallbackComposerId = composerIdFromPartial(partial);

  if (options.dryRun) {
    log("[dry-run] would run python cursor_composer_bridge.py --manifest <tmp>");
    return {
      ok: true,
      composerId: fallbackComposerId,
      exitCode: 0,
      stagedOnly: false,
    };
  }

  const scriptPath =
    options.bridgeScriptPath ?? (await resolveComposerBridgeScript(options.extensionPath));
  if (!scriptPath) {
    log("error: bridge script missing (scripts/cursor_composer_bridge.py)");
    const manifest = normalizeActivationManifest(
      rawManifest as unknown as Record<string, unknown>
    );
    await clearStaleResult(paths);
    await stagePendingManifest(manifest, paths);
    return { ok: false, exitCode: 1, stagedOnly: false };
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-activation-${Date.now()}.json`
  );
  const args = [scriptPath, "--manifest", tmpPath];
  if (waitResultMs > 0) {
    args.push("--wait-result", String(waitResultMs / 1000));
  }

  try {
    await fs.writeFile(
      tmpPath,
      JSON.stringify(rawManifest, null, 2) + "\n",
      "utf8"
    );

    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const proc = spawn("python3", args, { cwd: rawManifest.workspaceFolder });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });

    if (stderr.trim()) {
      for (const line of stderr.trim().split("\n")) {
        log(`bridge: ${line}`);
      }
    }

    const composerId = parseBridgeStdout(stdout) ?? fallbackComposerId;
    if (exitCode === 0) {
      await writeResultJson(composerId, true, paths);
      log(`Activation OK (bridge): composerId=${composerId}`);
      return {
        ok: true,
        composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }

    if (exitCode === 2) {
      log(
        `Activation staged only (exit 2): manifest at ${paths.pendingPath}; Cursor must be open on the workspace.`
      );
      return {
        ok: false,
        composerId: fallbackComposerId,
        exitCode: 2,
        stagedOnly: true,
      };
    }

    log(`error: bridge exited ${exitCode}`);
    return { ok: false, exitCode: 1, stagedOnly: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`bridge subprocess failed: ${message}`);
    return { ok: false, exitCode: 1, stagedOnly: false };
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

export async function runPostImportActivation(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string,
  workspaceCtx: WorkspaceContext,
  options: RunPostImportActivationOptions = {}
): Promise<ComposerActivationOutcome> {
  const log = options.log ?? (() => {});
  const paths = options.paths ?? defaultActivationPaths();
  const raw = buildActivationManifest(bundle, conversationId, workspaceCtx, {
    openInNewTab: options.openInNewTab,
  });
  const manifest = normalizeActivationManifest(
    raw as unknown as Record<string, unknown>
  );
  await enrichManifestPartialStateFromDisk(manifest, workspaceCtx.workspaceStorageId);

  log(`Activating composer ${conversationId}...`);

  const activationOutcome = await runComposerActivation(manifest, {
    paths,
    waitResultMs: options.bridgeWaitResultMs,
    log,
  });

  if (activationOutcome.ok) {
    const partial = manifest.partialState as Record<string, unknown>;
    const dbPath = stateDbPathForWorkspaceStorageId(workspaceCtx.workspaceStorageId);
    await repairComposerDataAfterActivation(dbPath, conversationId, partial);
    const { cursorUser } = resolveExtensionSyncRoots();
    const globalDb = path.join(cursorUser, "globalStorage", "state.vscdb");
    await repairComposerDataAfterActivation(globalDb, conversationId, partial);
    return activationOutcome;
  }

  if (!activationOutcome.stagedOnly) {
    return activationOutcome;
  }

  if (options.skipPythonBridge === true) {
    log(
      `Activation staged only: ${paths.pendingPath}. ` +
        "Cursor Sync will complete via composer.createComposer (reload window if needed)."
    );
    return activationOutcome;
  }

  log(
    `command ${manifest.commandId} unavailable; falling back to python bridge`
  );
  const bridgeOutcome = await runPythonComposerBridge(raw, {
    paths,
    waitResultMs: options.bridgeWaitResultMs,
    dryRun: options.dryRun,
    extensionPath: options.extensionPath,
    log,
  });

  if (options.activateStrict && bridgeOutcome.stagedOnly) {
    throw new Error(
      "Activation staged only (--activate-strict requires confirmed activation)"
    );
  }

  return bridgeOutcome;
}

export async function runComposerActivation(
  manifest: ActivationManifest,
  options: RunComposerActivationOptions = {}
): Promise<ComposerActivationOutcome> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});

  await clearStaleResult(paths);
  const stagePending = options.stagePending !== false;
  if (stagePending && !(await pendingManifestMatches(manifest, paths))) {
    await stagePendingManifest(manifest, paths);
  }

  const createAvailable = await composerCommandAvailable(manifest.commandId);

  const partial = manifest.partialState as Record<string, unknown>;
  const createNewOutcome = partialStateSafeForCreateNew(partial)
    ? await tryRegisterViaCreateNew(manifest, paths, log)
    : null;
  if (createNewOutcome && !createNewOutcome.ok) {
    log(
      `composer.createNew failed (exit ${createNewOutcome.exitCode}); ` +
        `falling back to ${manifest.commandId}`
    );
  } else if (createNewOutcome?.ok) {
    const openOutcome = await tryActivateViaComposerHandle(manifest, {
      ...options,
      acceptOpenWithoutHandle: options.acceptOpenWithoutHandle ?? true,
    });
    if (openOutcome?.ok) {
      return openOutcome;
    }
    return createNewOutcome;
  }

  if (createAvailable && partialStateSafeForCreateNew(partial)) {
    try {
      const commandResult = await vscode.commands.executeCommand(
        manifest.commandId,
        partialStateForCreateNewCommand(partial),
        manifest.createComposerOptions
      );
      const composerId = parseComposerIdFromCommandResult(
        commandResult,
        manifest.composerId
      );
      await writeResultJson(composerId, true, paths);
      log(`Activation OK: composerId=${composerId}`);
      return {
        ok: true,
        composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`composer.createComposer failed: ${message}`);
      return {
        ok: false,
        exitCode: 1,
        stagedOnly: false,
      };
    }
  }

  const handleOutcome = await tryActivateViaComposerHandle(manifest, options);
  if (handleOutcome?.ok) {
    return handleOutcome;
  }

  log(
    `IDE activation not available: command ${manifest.commandId} is not registered ` +
      `(fallback ${COMPOSER_GET_HANDLE_COMMAND_ID} also failed or unavailable).`
  );
  log(`Staged manifest: ${paths.pendingPath}`);

  const waitResultMs = Math.max(0, options.waitResultMs ?? 0);
  if (waitResultMs > 0) {
    const polled = await waitForActivationResult({
      paths,
      timeoutMs: waitResultMs,
    });
    if (polled) {
      return {
        ok: true,
        composerId: polled,
        exitCode: 0,
        stagedOnly: false,
      };
    }
  }

  return {
    ok: false,
    composerId: manifest.composerId,
    exitCode: 2,
    stagedOnly: true,
  };
}
