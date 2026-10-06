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
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import type { Manifest, ManifestFileEntry } from "./types.js";
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
  run?: AppConfigsRunHandle
): Promise<AppConfigsResponse> {
  if (run) {
    throwIfAppConfigsAborted(run);
  }

  const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
    method: "PUT",
    headers: {
      ...authHeaders(session),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload }),
  });

  if (response.status === 401) {
    throw new AppConfigsAbortedError("logout");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to push app configs (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as AppConfigsResponse;
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
      return remote;
    }
  }

  return decodePayloadFileContent(file, manifestEntry);
}

async function commitPartialAppConfigsPush(
  localPayload: AppConfigsPayloadV1,
  uploadedKeys: string[],
  session: string
): Promise<boolean> {
  if (uploadedKeys.length === 0) {
    return false;
  }
  const payload = buildMetadataOnlyPayloadForKeys(
    localPayload.manifest,
    localPayload.files,
    uploadedKeys
  );
  await putAppConfigsWithSession(session, payload);
  return true;
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
  const uploadedKeys: string[] = [];

  try {
    session = await requireAppSession(context);
    if (!session) {
      return false;
    }

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
    await putAppConfigsWithSession(session, payload, run);

    const fileCount = Object.keys(payload.files).length;
    vscode.window.showInformationMessage(
      `App configs push complete: ${fileCount} file(s) synced.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs succeeded: ${fileCount} files`
    );
    return true;
  } catch (err) {
    if (isAppConfigsAbortedError(err)) {
      if (session && localPayload && uploadedKeys.length > 0) {
        try {
          await commitPartialAppConfigsPush(localPayload, uploadedKeys, session);
        } catch (commitErr) {
          logger.appendLine(
            `[${new Date().toISOString()}] Push app configs partial commit failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`
          );
        }
      }
      logger.appendLine(
        `[${new Date().toISOString()}] Push app configs aborted (${err.reason})`
      );
      return false;
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
  let writtenBackups: Awaited<ReturnType<typeof createBackup>>["entries"] = [];

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
    const credentials = await getR2StorageCredentials(context, { silent: true });
    const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> =
      [];

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

      filesToWrite.push({
        absolutePath,
        syncKey,
        content,
      });
    }

    const config = vscode.workspace.getConfiguration("cursorSync");
    const safeMode = config.get<boolean>("safeMode") ?? true;

    if (safeMode && filesToWrite.length > 0) {
      const items = filesToWrite.map((f) => ({
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
      const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
      filesToWrite.length = 0;
      filesToWrite.push(...filtered);
    }

    if (filesToWrite.length === 0) {
      vscode.window.showInformationMessage("Pull app configs complete: no files to update.");
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return true;
    }

    const { entries: backupEntries } = await createBackup(
      context,
      filesToWrite.map((f) => f.absolutePath)
    );

    writtenBackups = [];
    for (const file of filesToWrite) {
      throwIfAppConfigsAborted(run);
      try {
        const dir = path.dirname(file.absolutePath);
        await fs.mkdir(dir, { recursive: true });
        const tmpPath = file.absolutePath + ".tmp";
        await fs.writeFile(tmpPath, file.content);
        await fs.rename(tmpPath, file.absolutePath);
        const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
        if (backup) {
          writtenBackups.push(backup);
        }
      } catch (err) {
        logger.appendLine(
          `[${new Date().toISOString()}] Pull app configs write failed for ${file.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
        );
        await rollbackFromBackup(writtenBackups);
        vscode.window.showErrorMessage(
          "Pull app configs failed: file write error. Changes have been rolled back."
        );
        return false;
      }
    }

    await pruneOldBackups(context);

    vscode.window.showInformationMessage(
      `Pull app configs complete: ${filesToWrite.length} file(s) updated.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs succeeded: ${filesToWrite.length} files`
    );
    return true;
  } catch (err) {
    if (isAppConfigsAbortedError(err)) {
      if (writtenBackups.length > 0) {
        await rollbackFromBackup(writtenBackups);
      }
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
