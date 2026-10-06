import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAppSession } from "./app-auth.js";
import { getAppApiUrl } from "./config/urls.js";
import {
  getR2Object,
  getR2StorageCredentials,
  putR2Object,
} from "./app-r2-storage.js";
import { generateExtensionsJson } from "./extensions.js";
import { getLogger } from "./diagnostics.js";
import { enumerateSyncFiles, resolveSyncRoots } from "./paths.js";
import { packageFiles } from "./packaging.js";
import { pruneOldBackups } from "./rollback.js";
import type { Manifest, ManifestFileEntry } from "./types.js";
import { computeChecksum } from "./packaging.js";
import {
  clearAppConfigRemoteDirty,
  markAppConfigRemoteDirty,
  readAppConfigRemoteDirty,
} from "./app-config-remote-state.js";
import {
  AppConfigsSessionExpiredError,
  isAppConfigsSessionExpiredError,
} from "./app-config-errors.js";
import { resolveSyncRootsRealpaths } from "./app-config-sync-path-safety.js";
import { executeAppConfigPullWrites, type PullWriteTarget } from "./app-config-pull-files.js";
import { collectJournalBackupDirs } from "./app-config-pull-journal.js";
import {
  AppConfigsAbortedError,
  beginAppConfigsRun,
  getSessionEpoch,
  isAppConfigsAbortedError,
  throwIfAppConfigsAborted,
  wasAppConfigsLogoutAbort,
  type AppConfigsRunHandle,
} from "./app-session-coordination.js";

export const APP_CONFIGS_PAYLOAD_SCHEMA_VERSION = 1 as const;

export interface AppConfigsPayloadFile {
  content?: string;
  encoding?: "base64";
  checksum?: string;
  sizeBytes?: number;
}

export interface AppConfigsPayloadV1 {
  schemaVersion: typeof APP_CONFIGS_PAYLOAD_SCHEMA_VERSION;
  manifest: Manifest;
  files: Record<string, AppConfigsPayloadFile>;
}

export interface AppConfigsResponse {
  payload: AppConfigsPayloadV1 | null;
  updated_at: string;
}

const LOGIN_REQUIRED_MESSAGE = "Log in to Cursor Sync to sync configs with the app.";
const SESSION_EXPIRED_MESSAGE =
  "Your Cursor Sync session expired. Log in again to sync configs with the app.";
const PUT_CONFIGS_TIMEOUT_MS = 15_000;
const PARTIAL_COMMIT_RETRIES = 2;

export async function hasAppSession(
  context: vscode.ExtensionContext
): Promise<boolean> {
  return !!(await getAppSession(context));
}

export async function requireAppSession(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const session = await getAppSession(context);
  if (!session) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }
  return session;
}

function appConfigsBaseUrl(): string {
  return getAppApiUrl();
}

function authHeaders(session: string): Record<string, string> {
  return {
    Authorization: `Bearer ${session}`,
    Accept: "application/json",
  };
}

export async function fetchAppConfigs(
  context: vscode.ExtensionContext
): Promise<AppConfigsResponse | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
  }

  const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
    method: "GET",
    headers: authHeaders(session),
  });

  if (response.status === 401) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch app configs (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as AppConfigsResponse;
}

async function putAppConfigsWithSession(
  session: string,
  payload: AppConfigsPayloadV1,
  options?: { run?: AppConfigsRunHandle }
): Promise<AppConfigsResponse> {
  const run = options?.run;
  if (run) {
    throwIfAppConfigsAborted(run);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PUT_CONFIGS_TIMEOUT_MS);
  const onRunAbort = () => controller.abort();
  run?.signal.addEventListener("abort", onRunAbort);

  try {
    const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
      method: "PUT",
      headers: {
        ...authHeaders(session),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload }),
      signal: controller.signal,
    });

    if (response.status === 401) {
      if (run?.signal.aborted) {
        throw new AppConfigsAbortedError("logout");
      }
      throw new AppConfigsSessionExpiredError();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Failed to push app configs (${response.status})${text ? `: ${text}` : ""}`
      );
    }

    return (await response.json()) as AppConfigsResponse;
  } finally {
    clearTimeout(timeout);
    run?.signal.removeEventListener("abort", onRunAbort);
  }
}

async function fetchRemoteConfigsPayload(
  session: string
): Promise<AppConfigsPayloadV1 | undefined> {
  const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
    method: "GET",
    headers: authHeaders(session),
  });
  if (!response.ok) {
    return undefined;
  }
  const data = (await response.json()) as AppConfigsResponse;
  if (!data.payload || data.payload.schemaVersion !== APP_CONFIGS_PAYLOAD_SCHEMA_VERSION) {
    return undefined;
  }
  return data.payload;
}

export function mergeUploadedKeysIntoRemotePayload(
  remote: AppConfigsPayloadV1,
  local: AppConfigsPayloadV1,
  uploadedKeys: string[]
): AppConfigsPayloadV1 {
  const manifestFiles = { ...remote.manifest.files };
  const metadataFiles: AppConfigsPayloadV1["files"] = { ...remote.files };
  for (const syncKey of uploadedKeys) {
    const manifestEntry = local.manifest.files[syncKey];
    const fileMeta = local.files[syncKey];
    if (!manifestEntry || !fileMeta) {
      continue;
    }
    manifestFiles[syncKey] = manifestEntry;
    metadataFiles[syncKey] = {
      checksum: fileMeta.checksum ?? manifestEntry.checksum,
      sizeBytes: fileMeta.sizeBytes ?? manifestEntry.sizeBytes,
      ...(manifestEntry.encoding ? { encoding: manifestEntry.encoding } : {}),
    };
  }
  return {
    schemaVersion: remote.schemaVersion,
    manifest: { ...remote.manifest, files: manifestFiles },
    files: metadataFiles,
  };
}

export async function putAppConfigs(
  context: vscode.ExtensionContext,
  payload: AppConfigsPayloadV1
): Promise<AppConfigsResponse | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
  }

  try {
    return await putAppConfigsWithSession(session, payload);
  } catch (err) {
    if (isAppConfigsAbortedError(err)) {
      return undefined;
    }
    throw err;
  }
}

export function buildMetadataOnlyPayloadForKeys(
  manifest: Manifest,
  files: Record<string, AppConfigsPayloadFile>,
  syncKeys: string[]
): AppConfigsPayloadV1 {
  const manifestFiles: Manifest["files"] = {};
  for (const syncKey of syncKeys) {
    const entry = manifest.files[syncKey];
    if (entry) {
      manifestFiles[syncKey] = entry;
    }
  }
  const filteredManifest: Manifest = {
    ...manifest,
    files: manifestFiles,
  };
  const filteredPayloadFiles: Record<string, AppConfigsPayloadFile> = {};
  for (const syncKey of syncKeys) {
    const file = files[syncKey];
    if (file) {
      filteredPayloadFiles[syncKey] = file;
    }
  }
  return buildMetadataOnlyPayload(filteredManifest, filteredPayloadFiles);
}

export function buildMetadataOnlyPayload(
  manifest: Manifest,
  files: Record<string, AppConfigsPayloadFile>
): AppConfigsPayloadV1 {
  const metadataFiles: Record<string, AppConfigsPayloadFile> = {};
  for (const [syncKey, manifestEntry] of Object.entries(manifest.files)) {
    const source = files[syncKey];
    metadataFiles[syncKey] = {
      checksum: source?.checksum ?? manifestEntry.checksum,
      sizeBytes: source?.sizeBytes ?? manifestEntry.sizeBytes,
      ...(manifestEntry.encoding ? { encoding: manifestEntry.encoding } : {}),
    };
  }

  return {
    schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
    manifest,
    files: metadataFiles,
  };
}

export async function buildLocalAppConfigsPayload(): Promise<AppConfigsPayloadV1> {
  const extensionsJson = generateExtensionsJson();
  const cursorUserRoot = resolveSyncRoots().cursorUser;
  const extensionsPath = path.join(cursorUserRoot, "extensions.json");
  await fs.mkdir(path.dirname(extensionsPath), { recursive: true });
  await fs.writeFile(extensionsPath, extensionsJson, "utf-8");

  const files = await enumerateSyncFiles();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest } = await packageFiles(files, profileName);

  const payloadFiles: Record<string, AppConfigsPayloadFile> = {};
  for (const [syncKey, entry] of packaged) {
    payloadFiles[syncKey] = {
      content: entry.content,
      checksum: entry.checksum,
      sizeBytes: entry.sizeBytes,
      ...(entry.encoding ? { encoding: entry.encoding } : {}),
    };
  }

  return {
    schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
    manifest,
    files: payloadFiles,
  };
}

function syncKeyToAbsolutePath(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }

  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }

  return undefined;
}

function decodePayloadFileContent(
  file: AppConfigsPayloadFile,
  manifestEntry: ManifestFileEntry
): Buffer | undefined {
  if (file.content === undefined) {
    return undefined;
  }
  if (manifestEntry.encoding === "base64" || file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }
  return Buffer.from(file.content, "utf-8");
}

async function resolveRemoteFileContent(
  context: vscode.ExtensionContext,
  syncKey: string,
  file: AppConfigsPayloadFile,
  manifestEntry: ManifestFileEntry,
  options?: {
    credentials?: Awaited<ReturnType<typeof getR2StorageCredentials>>;
    run?: AppConfigsRunHandle;
    silentCredentials?: boolean;
  }
): Promise<Buffer | undefined> {
  if (options?.run) {
    throwIfAppConfigsAborted(options.run);
  }

  const credentials =
    options?.credentials ??
    (await getR2StorageCredentials(context, { silent: options?.silentCredentials }));
  if (credentials) {
    const remote = await getR2Object(credentials, syncKey);
    if (remote) {
      const checksum = computeChecksum(remote);
      if (checksum !== manifestEntry.checksum) {
        getLogger().appendLine(
          `[${new Date().toISOString()}] Pull skipped checksum mismatch for ${syncKey}`
        );
        return undefined;
      }
      return remote;
    }
  }

  const decoded = decodePayloadFileContent(file, manifestEntry);
  if (!decoded) {
    return undefined;
  }
  const checksum = computeChecksum(decoded);
  if (checksum !== manifestEntry.checksum) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] Pull skipped embedded checksum mismatch for ${syncKey}`
    );
    return undefined;
  }
  return decoded;
}

async function commitPartialAppConfigsPush(
  context: vscode.ExtensionContext,
  remoteBaseline: AppConfigsPayloadV1,
  localPayload: AppConfigsPayloadV1,
  uploadedKeys: string[],
  session: string,
  run: AppConfigsRunHandle
): Promise<boolean> {
  if (uploadedKeys.length === 0) {
    return false;
  }
  const merged = mergeUploadedKeysIntoRemotePayload(
    remoteBaseline,
    localPayload,
    uploadedKeys
  );
  const payload = buildMetadataOnlyPayload(merged.manifest, merged.files);

  for (let attempt = 0; attempt < PARTIAL_COMMIT_RETRIES; attempt += 1) {
    try {
      await putAppConfigsWithSession(session, payload);
      await clearAppConfigRemoteDirty(context);
      return true;
    } catch (err) {
      if (isAppConfigsAbortedError(err)) {
        throw err;
      }
      if (attempt + 1 >= PARTIAL_COMMIT_RETRIES) {
        await markAppConfigRemoteDirty(context, "partial_commit_failed");
        return false;
      }
    }
  }
  return false;
}

function isAppConfigsPayloadV1(value: unknown): value is AppConfigsPayloadV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as AppConfigsPayloadV1;
  return (
    candidate.schemaVersion === APP_CONFIGS_PAYLOAD_SCHEMA_VERSION &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}

export async function executePushAppConfigs(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push app configs started`);

  const run = beginAppConfigsRun("push");
  let session: string | undefined;
  let localPayload: AppConfigsPayloadV1 | undefined;
  let remoteBaseline: AppConfigsPayloadV1 | undefined;
  const uploadedKeys: string[] = [];

  try {
    session = await requireAppSession(context);
    if (!session) {
      return false;
    }

    if (readAppConfigRemoteDirty(context)) {
      vscode.window.showWarningMessage(
        "App configs remote state needs reconciliation. Pull app configs before pushing again."
      );
    }

    remoteBaseline =
      (await fetchRemoteConfigsPayload(session)) ??
      ({
        schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
        manifest: {
          schemaVersion: 1,
          syncProfileName: "default",
          createdAt: new Date().toISOString(),
          sourceMachineId: "",
          sourceOS: "linux",
          files: {},
        },
        files: {},
      } satisfies AppConfigsPayloadV1);
    localPayload = await buildLocalAppConfigsPayload();
    throwIfAppConfigsAborted(run);
    const credentials = await getR2StorageCredentials(context);
    if (!credentials) {
      return false;
    }

    for (const [syncKey, file] of Object.entries(localPayload.files)) {
      throwIfAppConfigsAborted(run);
      const manifestEntry = localPayload.manifest.files[syncKey];
      if (!manifestEntry || file.content === undefined) {
        continue;
      }
      const encoding =
        manifestEntry.encoding === "base64" || file.encoding === "base64"
          ? "base64"
          : "utf-8";
      const body =
        encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : Buffer.from(file.content, "utf-8");
      await putR2Object(credentials, syncKey, body);
      uploadedKeys.push(syncKey);
    }

    throwIfAppConfigsAborted(run);
    const payload = buildMetadataOnlyPayload(
      localPayload.manifest,
      localPayload.files
    );
    await putAppConfigsWithSession(session, payload, { run });
    await clearAppConfigRemoteDirty(context);

    const fileCount = Object.keys(payload.files).length;
    vscode.window.showInformationMessage(
      `App configs push complete: ${fileCount} file(s) synced.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs succeeded: ${fileCount} files`
    );
    return true;
  } catch (err) {
    if (isAppConfigsSessionExpiredError(err)) {
      vscode.window.showErrorMessage(SESSION_EXPIRED_MESSAGE);
      return false;
    }
    if (isAppConfigsAbortedError(err)) {
      if (session && localPayload && remoteBaseline && uploadedKeys.length > 0) {
        const committed = await commitPartialAppConfigsPush(
          context,
          remoteBaseline,
          localPayload,
          uploadedKeys,
          session,
          run
        );
        if (!committed) {
          logger.appendLine(
            `[${new Date().toISOString()}] Push app configs partial commit failed after abort`
          );
        }
      }
      logger.appendLine(
        `[${new Date().toISOString()}] Push app configs aborted (${err.reason})`
      );
      return false;
    }
    if (uploadedKeys.length > 0) {
      await markAppConfigRemoteDirty(context, "push_failed_after_upload");
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs failed: ${message}`
    );
    vscode.window.showErrorMessage(`Push app configs failed: ${message}`);
    return false;
  } finally {
    run.end();
  }
}

export async function executePullAppConfigs(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull app configs started`);

  const run = beginAppConfigsRun("pull");

  try {
    throwIfAppConfigsAborted(run);
    const response = await fetchAppConfigs(context);
    if (!response) {
      return false;
    }

    if (!response.payload || !isAppConfigsPayloadV1(response.payload)) {
      vscode.window.showInformationMessage("Pull app configs complete: no remote configs.");
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs: empty or invalid payload`
      );
      return true;
    }

    const { manifest, files } = response.payload;
    const roots = resolveSyncRoots();
    const resolved = await resolveSyncRootsRealpaths(roots);
    const credentials = await getR2StorageCredentials(context, { silent: true });
    const pullTargets: PullWriteTarget[] = [];

    for (const [syncKey, file] of Object.entries(files)) {
      throwIfAppConfigsAborted(run);
      const manifestEntry = manifest.files[syncKey];
      if (!manifestEntry) {
        continue;
      }

      const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
      if (!absolutePath) {
        continue;
      }

      const content = await resolveRemoteFileContent(context, syncKey, file, manifestEntry, {
        credentials,
        run,
        silentCredentials: true,
      });
      if (!content) {
        continue;
      }

      pullTargets.push({
        absolutePath,
        syncKey,
        content,
        expectedChecksum: manifestEntry.checksum,
      });
    }

    const config = vscode.workspace.getConfiguration("cursorSync");
    const safeMode = config.get<boolean>("safeMode") ?? true;

    if (safeMode && pullTargets.length > 0) {
      const items = pullTargets.map((f) => ({
        label: f.syncKey,
        picked: true,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "App configs files to overwrite",
        placeHolder: "Deselect files you do not want to overwrite",
      });

      if (!selected) {
        logger.appendLine(`[${new Date().toISOString()}] Pull app configs cancelled by user`);
        return false;
      }

      const selectedKeys = new Set(selected.map((s) => s.label));
      const filtered = pullTargets.filter((f) => selectedKeys.has(f.syncKey));
      pullTargets.length = 0;
      pullTargets.push(...filtered);
    }

    if (pullTargets.length === 0) {
      vscode.window.showInformationMessage("Pull app configs complete: no files to update.");
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return true;
    }

    await executeAppConfigPullWrites(context, run, pullTargets, resolved);

    const protectedDirs = await collectJournalBackupDirs(context);
    await pruneOldBackups(context, { protectedBackupDirs: protectedDirs });

    vscode.window.showInformationMessage(
      `Pull app configs complete: ${pullTargets.length} file(s) updated.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs succeeded: ${pullTargets.length} files`
    );
    return true;
  } catch (err) {
    if (isAppConfigsAbortedError(err)) {
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs aborted (${err.reason})`
      );
      if (wasAppConfigsLogoutAbort() || run.epoch !== getSessionEpoch()) {
        vscode.window.showInformationMessage("Logged out, pull cancelled.");
      }
      return false;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs failed: ${message}`
    );
    vscode.window.showErrorMessage(`Pull app configs failed: ${message}`);
    return false;
  } finally {
    run.end();
  }
}
