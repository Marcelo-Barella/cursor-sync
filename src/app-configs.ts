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
import { addSyncHistoryEntry, getLogger } from "./diagnostics.js";
import {
  formatPullEmptyToast,
  formatPullSuccessToast,
  formatPushSuccessToast,
  syncDestinationLabel,
} from "./sync-destination.js";
import { enumerateSyncFiles, resolveSyncRoots } from "./paths.js";
import { packageFiles } from "./packaging.js";
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import { computeChecksum } from "./packaging.js";
import type { Manifest, ManifestFileEntry } from "./types.js";

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

const LOGIN_REQUIRED_MESSAGE = `Log in to Cursor Sync to sync with ${syncDestinationLabel("cursor-sync-storage")}.`;

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

async function recordAppStorageAuthFailure(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: "manual" | "scheduled",
  error: string
): Promise<void> {
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction,
    trigger,
    fileCount: 0,
    success: false,
    destination: "cursor-sync-storage",
    error,
  });
}

export function formatSyncRootsSummary(roots: { cursorUser: string; dotCursor: string }): string {
  return `cursor-user=${roots.cursorUser}, dot-cursor=${roots.dotCursor}`;
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
    const message = `Cursor Sync storage session expired or invalid. ${LOGIN_REQUIRED_MESSAGE}`;
    await recordAppStorageAuthFailure(context, "pull", "manual", message);
    vscode.window.showErrorMessage(message);
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

export async function putAppConfigs(
  context: vscode.ExtensionContext,
  payload: AppConfigsPayloadV1
): Promise<AppConfigsResponse | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
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
    const message = `Cursor Sync storage session expired or invalid. ${LOGIN_REQUIRED_MESSAGE}`;
    await recordAppStorageAuthFailure(context, "push", "manual", message);
    vscode.window.showErrorMessage(message);
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to push app configs (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as AppConfigsResponse;
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

export interface LocalAppConfigsBuildResult {
  payload: AppConfigsPayloadV1;
  roots: { cursorUser: string; dotCursor: string };
  enumeratedCount: number;
  skippedReads: Array<{ relativeSyncKey: string; reason: string }>;
}

export async function buildLocalAppConfigsPayload(
  context: vscode.ExtensionContext
): Promise<LocalAppConfigsBuildResult> {
  const extensionsJson = generateExtensionsJson();
  const roots = resolveSyncRoots(process.platform, context);
  const cursorUserRoot = roots.cursorUser;
  const extensionsPath = path.join(cursorUserRoot, "extensions.json");
  await fs.mkdir(path.dirname(extensionsPath), { recursive: true });
  await fs.writeFile(extensionsPath, extensionsJson, "utf-8");

  const files = await enumerateSyncFiles(context, roots);
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest, skipped } = await packageFiles(files, profileName, {
    skipUnreadable: true,
  });

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
    payload: {
      schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
      manifest,
      files: payloadFiles,
    },
    roots,
    enumeratedCount: files.length,
    skippedReads: skipped,
  };
}

export async function computeLocalAppConfigChecksums(
  context: vscode.ExtensionContext
): Promise<Record<string, string>> {
  const roots = resolveSyncRoots(process.platform, context);
  const localFiles = await enumerateSyncFiles(context, roots);
  const checksums: Record<string, string> = {};
  for (const file of localFiles) {
    try {
      const buf = await fs.readFile(file.absolutePath);
      checksums[file.relativeSyncKey] = computeChecksum(buf);
    } catch {
      continue;
    }
  }
  return checksums;
}

export type AppStorageSyncAction =
  | { action: "none" }
  | { action: "pull" }
  | { action: "push" }
  | { action: "pull-push" }
  | { action: "error"; reason: string };

export async function determineAppStorageSyncAction(
  context: vscode.ExtensionContext
): Promise<AppStorageSyncAction> {
  const response = await fetchAppConfigs(context);
  if (!response) {
    return { action: "error", reason: "app_storage_auth" };
  }

  const localChecksums = await computeLocalAppConfigChecksums(context);

  if (!response.payload || !isAppConfigsPayloadV1(response.payload)) {
    return Object.keys(localChecksums).length > 0 ? { action: "push" } : { action: "none" };
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(response.payload.manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
  ]);

  let localHasChanges = false;
  let remoteHasChanges = false;

  for (const key of allKeys) {
    const local = localChecksums[key];
    const remote = remoteChecksums[key];
    if (local !== remote) {
      if (local !== undefined && remote === undefined) {
        localHasChanges = true;
      } else if (local === undefined && remote !== undefined) {
        remoteHasChanges = true;
      } else if (local !== remote) {
        localHasChanges = true;
        remoteHasChanges = true;
      }
    }
  }

  if (localHasChanges && remoteHasChanges) {
    return { action: "pull-push" };
  }
  if (remoteHasChanges) {
    return { action: "pull" };
  }
  if (localHasChanges) {
    return { action: "push" };
  }
  return { action: "none" };
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
  manifestEntry: ManifestFileEntry
): Promise<Buffer | undefined> {
  const credentials = await getR2StorageCredentials(context);
  if (credentials) {
    const remote = await getR2Object(credentials, syncKey);
    if (remote) {
      return remote;
    }
  }

  return decodePayloadFileContent(file, manifestEntry);
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

export type AppConfigsSyncOptions = {
  trigger?: "manual" | "scheduled";
};

export async function executePushAppConfigs(
  context: vscode.ExtensionContext,
  options?: AppConfigsSyncOptions
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const destination = "cursor-sync-storage" as const;
  const destinationLabel = syncDestinationLabel(destination);
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push app configs started`);

  try {
    const buildResult = await buildLocalAppConfigsPayload(context);
    const { payload: localPayload, roots, enumeratedCount, skippedReads } = buildResult;
    const skipped: Array<{ syncKey: string; reason: string }> = skippedReads.map((s) => ({
      syncKey: s.relativeSyncKey,
      reason: s.reason,
    }));

    if (enumeratedCount === 0) {
      const message = `Push to ${destinationLabel} failed: no syncable files found under ${formatSyncRootsSummary(roots)}.`;
      await recordAppStorageAuthFailure(context, "push", trigger, message);
      vscode.window.showErrorMessage(message);
      return false;
    }

    const credentials = await getR2StorageCredentials(context);
    if (!credentials) {
      await recordAppStorageAuthFailure(context, "push", trigger, LOGIN_REQUIRED_MESSAGE);
      return false;
    }

    let uploadedCount = 0;
    const uploadedKeys: string[] = [];

    for (const [syncKey, file] of Object.entries(localPayload.files)) {
      const manifestEntry = localPayload.manifest.files[syncKey];
      if (!manifestEntry) {
        skipped.push({ syncKey, reason: "missing manifest entry" });
        continue;
      }
      if (file.content === undefined) {
        skipped.push({ syncKey, reason: "no inline content to upload" });
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
      try {
        const status = await putR2Object(credentials, syncKey, body);
        uploadedCount += 1;
        uploadedKeys.push(syncKey);
        logger.appendLine(
          `[${new Date().toISOString()}] Uploaded ${syncKey} (${body.length} bytes) status=${status}`
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ syncKey, reason });
        logger.appendLine(
          `[${new Date().toISOString()}] Upload failed ${syncKey}: ${reason}`
        );
      }
    }

    if (uploadedCount === 0 || skipped.length > 0) {
      const detail = skipped.map((s) => `${s.syncKey}: ${s.reason}`).join("; ");
      const message =
        uploadedCount === 0
          ? `Push to ${destinationLabel} failed: no files uploaded.${detail ? ` Skipped: ${detail}` : ""}`
          : `Push to ${destinationLabel} failed: partial upload (${uploadedCount} succeeded). Skipped: ${detail}. Remote /configs metadata was not updated.`;
      logger.appendLine(`[${new Date().toISOString()}] Push app configs failed: ${message}`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: uploadedCount,
        success: false,
        destination,
        error: message,
      });
      vscode.window.showErrorMessage(message);
      return false;
    }

    const uploadedFiles: Record<string, AppConfigsPayloadFile> = {};
    for (const key of uploadedKeys) {
      uploadedFiles[key] = localPayload.files[key]!;
    }
    const manifestFiles: Manifest["files"] = {};
    for (const key of uploadedKeys) {
      manifestFiles[key] = localPayload.manifest.files[key]!;
    }
    const metadataPayload = buildMetadataOnlyPayload(
      { ...localPayload.manifest, files: manifestFiles },
      uploadedFiles
    );
    const result = await putAppConfigs(context, metadataPayload);
    if (!result) {
      return false;
    }

    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "push",
      trigger,
      fileCount: uploadedCount,
      success: true,
      destination,
    });
    vscode.window.showInformationMessage(
      formatPushSuccessToast(uploadedCount, destination)
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs succeeded: ${uploadedCount} files`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs failed: ${message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "push",
      trigger,
      fileCount: 0,
      success: false,
      destination,
      error: message,
    });
    vscode.window.showErrorMessage(`Push to ${destinationLabel} failed: ${message}`);
    return false;
  }
}

export async function executePullAppConfigs(
  context: vscode.ExtensionContext,
  options?: AppConfigsSyncOptions
): Promise<boolean> {
  const trigger = options?.trigger ?? "manual";
  const destination = "cursor-sync-storage" as const;
  const destinationLabel = syncDestinationLabel(destination);
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull app configs started`);

  try {
    const response = await fetchAppConfigs(context);
    if (!response) {
      return false;
    }

    if (!response.payload || !isAppConfigsPayloadV1(response.payload)) {
      vscode.window.showInformationMessage(formatPullEmptyToast(destination));
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs: empty or invalid payload`
      );
      return true;
    }

    const { manifest, files } = response.payload;
    const roots = resolveSyncRoots(process.platform, context);
    const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> =
      [];

    for (const [syncKey, file] of Object.entries(files)) {
      const manifestEntry = manifest.files[syncKey];
      if (!manifestEntry) {
        continue;
      }

      const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
      if (!absolutePath) {
        continue;
      }

      const content = await resolveRemoteFileContent(
        context,
        syncKey,
        file,
        manifestEntry
      );
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
        title: "Cursor Sync storage: files to overwrite",
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
      vscode.window.showInformationMessage(formatPullEmptyToast(destination));
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return true;
    }

    const { entries: backupEntries } = await createBackup(
      context,
      filesToWrite.map((f) => f.absolutePath)
    );

    const writtenBackups: typeof backupEntries = [];
    for (const file of filesToWrite) {
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
        const writeErrorMessage = `Pull from ${destinationLabel} failed: file write error. Changes have been rolled back.`;
        await addSyncHistoryEntry(context, {
          timestamp: new Date().toISOString(),
          direction: "pull",
          trigger,
          fileCount: 0,
          success: false,
          destination,
          error: writeErrorMessage,
        });
        vscode.window.showErrorMessage(writeErrorMessage);
        return false;
      }
    }

    await pruneOldBackups(context);

    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: filesToWrite.length,
      success: true,
      destination,
    });
    vscode.window.showInformationMessage(
      formatPullSuccessToast(filesToWrite.length, destination)
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs succeeded: ${filesToWrite.length} files`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs failed: ${message}`
    );
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: 0,
      success: false,
      destination,
      error: message,
    });
    vscode.window.showErrorMessage(`Pull from ${destinationLabel} failed: ${message}`);
    return false;
  }
}
