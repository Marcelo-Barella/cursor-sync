import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAppSession } from "./app-auth.js";
import { appStorageAccountKey } from "./app-session-identity.js";
import { getAppApiUrl } from "./config/urls.js";
import {
  deleteR2Object,
  getR2Object,
  getR2StorageCredentials,
  putR2Object,
} from "./app-r2-storage.js";
import { generateExtensionsJson } from "./extensions.js";
import { addSyncHistoryEntry, getLogger } from "./diagnostics.js";
import {
  formatPullEmptyToast,
  formatPullPartialToast,
  formatPullSuccessToast,
  formatPushPartialToast,
  formatPushRemovalToast,
  formatPushSuccessToast,
  syncDestinationLabel,
} from "./sync-destination.js";
import {
  buildTrackingScopeForBaseline,
  scanLocalAppConfigFiles,
} from "./app-config-local-scan.js";
import { AppConfigsFetchError, isAppConfigsFetchError } from "./app-config-fetch-errors.js";
import { evaluateRemoteDeleteBatch } from "./app-storage-delete-guard.js";
import {
  alignGeneratedOnlyLocalChecksums,
  GENERATED_EXTENSIONS_SYNC_KEY,
} from "./app-config-extensions-align.js";
import {
  appStorageSyncActionFromClassification,
  baselineHasEntries,
  baselineKeyTracked,
  classifyAppStorageKeys,
  baselineKeyTracked,
  filterScheduledAppStoragePullKeys,
  loadAppStorageBaseline,
  shouldPullAppConfigFile,
  updateAppStorageBaselineAfterSync,
} from "./app-storage-baseline.js";
import { enumerateSyncFiles, resolveSyncRoots, syncKeyToAbsolutePath } from "./paths.js";
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

export type AppConfigsSyncTrigger =
  | "manual"
  | "scheduled"
  | "syncNow"
  | "startup";

async function recordAppStorageAuthFailure(
  context: vscode.ExtensionContext,
  direction: "push" | "pull",
  trigger: AppConfigsSyncTrigger,
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
  context: vscode.ExtensionContext,
  options?: {
    trigger?: AppConfigsSyncTrigger;
    recordAuthFailure?: boolean;
    recordHttpFailureInHistory?: boolean;
    authFailureDirection?: "push" | "pull";
  }
): Promise<AppConfigsResponse | undefined> {
  const trigger = options?.trigger ?? "manual";
  const recordAuthFailure = options?.recordAuthFailure ?? true;
  const recordHttpFailureInHistory = options?.recordHttpFailureInHistory ?? true;
  const authFailureDirection = options?.authFailureDirection ?? "pull";
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
    if (recordAuthFailure) {
      await recordAppStorageAuthFailure(context, authFailureDirection, trigger, message);
      vscode.window.showErrorMessage(message);
    }
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = `Failed to fetch app configs (${response.status})${text ? `: ${text}` : ""}`;
    let historyRecorded = false;
    if (response.status >= 500 && recordHttpFailureInHistory) {
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: authFailureDirection,
        trigger,
        fileCount: 0,
        success: false,
        destination: "cursor-sync-storage",
        error: message,
      });
      historyRecorded = true;
    }
    throw new AppConfigsFetchError(message, historyRecorded);
  }

  return (await response.json()) as AppConfigsResponse;
}

export async function putAppConfigs(
  context: vscode.ExtensionContext,
  payload: AppConfigsPayloadV1,
  options?: { trigger?: AppConfigsSyncTrigger }
): Promise<AppConfigsResponse | undefined> {
  const trigger = options?.trigger ?? "manual";
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
    await recordAppStorageAuthFailure(context, "push", trigger, message);
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

export function countMeaningfulAppConfigKeys(
  payload: AppConfigsPayloadV1
): number {
  const keys = Object.keys(payload.manifest.files);
  if (keys.length === 0) {
    return 0;
  }
  return keys.filter((key) => !isGeneratedOnlyAppConfigKey(key, payload)).length;
}

function isGeneratedOnlyAppConfigKey(
  syncKey: string,
  payload: AppConfigsPayloadV1
): boolean {
  if (syncKey !== GENERATED_EXTENSIONS_SYNC_KEY) {
    return false;
  }
  const content = payload.files[syncKey]?.content;
  return isEmptyExtensionsJsonContent(content);
}

function isEmptyExtensionsJsonContent(content: string | undefined): boolean {
  return content === "[]" || content === "[\n]\n" || content === "[\n]";
}

async function localExtensionsJsonIsEmpty(
  roots: { cursorUser: string; dotCursor: string }
): Promise<boolean> {
  try {
    const buf = await fs.readFile(path.join(roots.cursorUser, "extensions.json"));
    const text = buf.toString("utf-8").trim();
    return text === "[]" || text === "[\n]" || text === "[\n]\n";
  } catch {
    return false;
  }
}

export const APP_STORAGE_SESSION_EXPIRED_MESSAGE =
  "Session expired, log in again.";

export async function recordAppStorageSessionExpired(
  context: vscode.ExtensionContext,
  trigger: AppConfigsSyncTrigger
): Promise<void> {
  await recordAppStorageAuthFailure(
    context,
    "pull",
    trigger,
    APP_STORAGE_SESSION_EXPIRED_MESSAGE
  );
  vscode.window.showErrorMessage(APP_STORAGE_SESSION_EXPIRED_MESSAGE);
}

function filterPushKeysForRemoteDeletedUnchanged(
  pushKeys: string[],
  baseline: Awaited<ReturnType<typeof loadAppStorageBaseline>>,
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>
): string[] {
  if (!baseline) {
    return pushKeys;
  }
  return pushKeys.filter((key) => {
    const wasRemote = baseline.remoteChecksums[key];
    const curRemote = remoteChecksums[key];
    const wasLocal = baseline.localChecksums[key];
    const curLocal = localChecksums[key];
    if (
      wasRemote !== undefined &&
      curRemote === undefined &&
      wasLocal !== undefined &&
      curLocal === wasLocal
    ) {
      return false;
    }
    return true;
  });
}

function filterGeneratedOnlyPushKeys(
  pushKeys: string[],
  localChecksums: Record<string, string>,
  extensionsEmpty: boolean
): string[] {
  if (!extensionsEmpty) {
    return pushKeys;
  }
  return pushKeys.filter((key) => key !== GENERATED_EXTENSIONS_SYNC_KEY);
}

function isEmptyOrDefaultSettingsContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === "{}" || trimmed.length === 0) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
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
  | { action: "pull"; keys: string[]; remoteDeletions: string[] }
  | { action: "push"; keys: string[]; deletions: string[] }
  | { action: "conflict"; keys: string[] }
  | { action: "baseline_refresh"; keys: string[] }
  | { action: "error"; reason: string };

export async function determineAppStorageSyncAction(
  context: vscode.ExtensionContext,
  options?: { trigger?: AppConfigsSyncTrigger }
): Promise<AppStorageSyncAction> {
  const session = await getAppSession(context);
  if (!session) {
    return { action: "error", reason: "app_storage_auth" };
  }

  const trigger = options?.trigger ?? "manual";
  const response = await fetchAppConfigs(context, {
    ...options,
    recordAuthFailure: false,
    recordHttpFailureInHistory: true,
    authFailureDirection: "pull",
  });
  if (!response) {
    await recordAppStorageSessionExpired(context, trigger);
    return { action: "error", reason: "session_expired" };
  }

  const roots = resolveSyncRoots(process.platform, context);
  const extensionsEmpty = await localExtensionsJsonIsEmpty(roots);
  const accountKey = appStorageAccountKey(session, getAppApiUrl());
  const baseline = await loadAppStorageBaseline(
    context,
    accountKey,
    "cursor-sync-storage",
    session
  );
  const localScan = await scanLocalAppConfigFiles(context, baseline);
  let localChecksums = { ...localScan.checksums };

  if (!response.payload || !isAppConfigsPayloadV1(response.payload)) {
    const build = await buildLocalAppConfigsPayload(context);
    const meaningful = countMeaningfulAppConfigKeys(build.payload);
    if (meaningful === 0) {
      return { action: "none" };
    }
    const keys = Object.keys(build.payload.manifest.files).filter(
      (k) => !isGeneratedOnlyAppConfigKey(k, build.payload)
    );
    return { action: "push", keys, deletions: [] };
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(response.payload.manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  localChecksums = alignGeneratedOnlyLocalChecksums(
    localChecksums,
    remoteChecksums,
    baseline,
    extensionsEmpty
  );

  const classified = classifyAppStorageKeys(
    localChecksums,
    remoteChecksums,
    baseline,
    localScan
  );
  const derived = appStorageSyncActionFromClassification(
    classified,
    remoteChecksums
  );

  if (derived.action === "push") {
    const build = await buildLocalAppConfigsPayload(context);
    let pushKeys = derived.keys.filter(
      (k) => !isGeneratedOnlyAppConfigKey(k, build.payload)
    );
    pushKeys = filterGeneratedOnlyPushKeys(
      pushKeys,
      localChecksums,
      extensionsEmpty
    );
    pushKeys = filterPushKeysForRemoteDeletedUnchanged(
      pushKeys,
      baseline,
      localChecksums,
      remoteChecksums
    );
    pushKeys = pushKeys.filter((k) => !localScan.skippedUnknownKeys.has(k));
    let deletions = derived.deletions.filter((k) =>
      localScan.provablyAbsentKeys.has(k)
    );
    if (!localScan.deletesAllowed) {
      deletions = [];
    }
    const trackedCount = baseline
      ? Object.keys(baseline.localChecksums).length
      : 0;
    const deleteDecision = evaluateRemoteDeleteBatch(
      deletions,
      trackedCount,
      trigger,
      localScan
    );
    if (deleteDecision.schedulerBlocked && deletions.length > 0) {
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        destination: "cursor-sync-storage",
        error: deleteDecision.reason,
      });
      void vscode.window.showWarningMessage(deleteDecision.reason ?? "Scheduled delete blocked");
      deletions = [];
    }
    if (pushKeys.length === 0 && deletions.length === 0) {
      if (localScan.unreadableKeys.size > 0) {
        return { action: "none" };
      }
      return { action: "none" };
    }
    return { action: "push", keys: pushKeys, deletions };
  }

  if (derived.action === "baseline_refresh") {
    return { action: "baseline_refresh", keys: derived.keys };
  }

  if (derived.action === "conflict") {
    return { action: "conflict", keys: derived.keys };
  }

  if (derived.action === "pull") {
    let pullKeys = derived.keys;
    if (trigger === "scheduled") {
      pullKeys = filterScheduledAppStoragePullKeys(
        pullKeys,
        baseline,
        localChecksums
      );
    }
    let remoteDeletions = [...derived.remoteDeletions];
    const trackedCountPull = baseline
      ? Object.keys(baseline.localChecksums).length
      : 0;
    const localDeleteDecision = evaluateRemoteDeleteBatch(
      remoteDeletions,
      trackedCountPull,
      trigger,
      localScan
    );
    if (localDeleteDecision.schedulerBlocked && remoteDeletions.length > 0) {
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        destination: "cursor-sync-storage",
        error: localDeleteDecision.reason,
      });
      void vscode.window.showWarningMessage(
        localDeleteDecision.reason ?? "Scheduled local delete blocked"
      );
      remoteDeletions = [];
    }
    if (pullKeys.length === 0 && remoteDeletions.length === 0) {
      return { action: "none" };
    }
    return {
      action: "pull",
      keys: pullKeys,
      remoteDeletions,
    };
  }

  return { action: "none" };
}

export async function applyAppStorageBaselineRefresh(
  context: vscode.ExtensionContext,
  keys: string[],
  remoteUpdatedAt: string
): Promise<void> {
  const session = await getAppSession(context);
  if (!session) {
    return;
  }
  const accountKey = appStorageAccountKey(session, getAppApiUrl());
  const baseline = await loadAppStorageBaseline(
    context,
    accountKey,
    "cursor-sync-storage",
    session
  );
  const localScan = await scanLocalAppConfigFiles(context, baseline);
  const localChecksums = localScan.checksums;
  const response = await fetchAppConfigs(context, { recordAuthFailure: false });
  const remoteChecksums: Record<string, string> = {};
  if (response?.payload && isAppConfigsPayloadV1(response.payload)) {
    for (const [key, entry] of Object.entries(response.payload.manifest.files)) {
      remoteChecksums[key] = entry.checksum;
    }
  }
  const deletedKeys = keys.filter(
    (key) =>
      localChecksums[key] === undefined && remoteChecksums[key] === undefined
  );
  const syncedKeys = keys.filter((key) => !deletedKeys.includes(key));
  await updateAppStorageBaselineAfterSync(context, {
    accountKey,
    destination: "cursor-sync-storage",
    remoteUpdatedAt,
    syncedKeys,
    deletedKeys,
    localChecksums,
    remoteChecksums,
    trackingScope: buildTrackingScopeForBaseline(context),
  });
}

export async function notifyAppStorageConflicts(
  context: vscode.ExtensionContext,
  keys: string[],
  options?: { scheduled?: boolean; trigger?: AppConfigsSyncTrigger }
): Promise<void> {
  const preview = keys.slice(0, 5).join(", ");
  const suffix = keys.length > 5 ? ` (+${keys.length - 5} more)` : "";
  const message = options?.scheduled
    ? `Scheduled Cursor Sync storage sync skipped: ${keys.length} conflicting file(s) (${preview}${suffix}). Resolve manually.`
    : `Cursor Sync storage conflict on ${keys.length} file(s): ${preview}${suffix}. Nothing was overwritten.`;
  const trigger = options?.trigger ?? (options?.scheduled ? "scheduled" : "syncNow");
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: keys.length,
    success: false,
    conflict: true,
    destination: "cursor-sync-storage",
    error: message,
  });
  if (options?.scheduled) {
    await vscode.window.showWarningMessage(message);
  } else {
    await vscode.window.showErrorMessage(message);
  }
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
  trigger?: AppConfigsSyncTrigger;
  keys?: string[];
  deletions?: string[];
  remoteDeletions?: string[];
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

    const meaningfulCount = countMeaningfulAppConfigKeys(localPayload);
    const keysToUpload =
      options?.keys ??
      Object.keys(localPayload.files).filter(
        (k) => !isGeneratedOnlyAppConfigKey(k, localPayload)
      );
    const deletions = options?.deletions ?? [];

    if (meaningfulCount === 0 && keysToUpload.length === 0 && deletions.length === 0) {
      const message = `Push to ${destinationLabel} failed: no syncable files found under ${formatSyncRootsSummary(roots)}.`;
      await recordAppStorageAuthFailure(context, "push", trigger, message);
      vscode.window.showErrorMessage(message);
      return false;
    }

    const remoteBefore = await fetchAppConfigs(context, {
      trigger,
      authFailureDirection: "push",
    });
    if (!remoteBefore) {
      return false;
    }
    const remoteManifestFiles =
      remoteBefore.payload && isAppConfigsPayloadV1(remoteBefore.payload)
        ? remoteBefore.payload.manifest.files
        : {};

    const sessionEarly = await getAppSession(context);
    const accountKeyEarly = sessionEarly
      ? appStorageAccountKey(sessionEarly, getAppApiUrl())
      : "";
    const baselineEarly = sessionEarly
      ? await loadAppStorageBaseline(
          context,
          accountKeyEarly,
          "cursor-sync-storage",
          sessionEarly
        )
      : undefined;

    if (
      !baselineHasEntries(baselineEarly) &&
      Object.keys(remoteManifestFiles).length > 0 &&
      meaningfulCount === 0 &&
      deletions.length === 0
    ) {
      const message = `Push to ${destinationLabel} skipped: remote already has configs and local profile is empty. Pull first.`;
      vscode.window.showWarningMessage(message);
      return false;
    }

    const settingsKey = "cursor-user/settings.json";
    const settingsInline = localPayload.files[settingsKey]?.content;
    if (
      !baselineHasEntries(baselineEarly) &&
      Object.keys(remoteManifestFiles).length > 0 &&
      keysToUpload.includes(settingsKey) &&
      settingsInline !== undefined &&
      isEmptyOrDefaultSettingsContent(settingsInline)
    ) {
      const confirm = await vscode.window.showWarningMessage(
        `Local settings are empty but ${destinationLabel} already has configs. Overwrite remote settings?`,
        "Push anyway",
        "Cancel"
      );
      if (confirm !== "Push anyway") {
        return false;
      }
    }

    const config = vscode.workspace.getConfiguration("cursorSync");
    const safeMode = config.get<boolean>("safeMode") ?? true;
    if (safeMode && deletions.length > 0) {
      const items = deletions.map((key) => ({ label: key, picked: false }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Cursor Sync storage: files to remove from remote",
        placeHolder: "Select files to remove from the server",
      });
      if (!selected) {
        vscode.window.showInformationMessage(
          `Push to ${destinationLabel} cancelled. Nothing was changed.`
        );
        return false;
      }
      const allowed = new Set(selected.map((s) => s.label));
      for (let i = deletions.length - 1; i >= 0; i--) {
        if (!allowed.has(deletions[i]!)) {
          deletions.splice(i, 1);
        }
      }
    }

    const pushScan = await scanLocalAppConfigFiles(context, baselineEarly);
    for (let i = deletions.length - 1; i >= 0; i--) {
      if (!pushScan.provablyAbsentKeys.has(deletions[i]!)) {
        deletions.splice(i, 1);
      }
    }
    const trackedForDelete = baselineEarly
      ? Object.keys(baselineEarly.localChecksums).length
      : 0;
    const pushDeleteDecision = evaluateRemoteDeleteBatch(
      deletions,
      trackedForDelete,
      trigger,
      pushScan
    );
    if (!pushDeleteDecision.proceed && deletions.length > 0) {
      if (pushDeleteDecision.needsModalConfirm) {
        const confirm = await vscode.window.showWarningMessage(
          pushDeleteDecision.reason ??
            `Delete ${deletions.length} files from Cursor Sync storage?`,
          { modal: true },
          "Delete remotely",
          "Cancel"
        );
        if (confirm !== "Delete remotely") {
          deletions.length = 0;
        }
      } else {
        vscode.window.showWarningMessage(
          pushDeleteDecision.reason ?? "Remote delete blocked"
        );
        deletions.length = 0;
      }
    }

    const credentials = await getR2StorageCredentials(context);
    if (!credentials) {
      await recordAppStorageAuthFailure(context, "push", trigger, LOGIN_REQUIRED_MESSAGE);
      return false;
    }

    let uploadedCount = 0;
    let deletedCount = 0;
    const uploadedKeys: string[] = [];
    const deletedKeys: string[] = [];
    const unreadableSkipCount = skippedReads.length;

    const uploadSet = new Set(keysToUpload);
    for (const [syncKey, file] of Object.entries(localPayload.files)) {
      if (!uploadSet.has(syncKey)) {
        continue;
      }
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

    const uploadAttempted = uploadSet.size > 0;
    const uploadSkipped = skipped.filter((s) => uploadSet.has(s.syncKey));
    const uploadFailed =
      uploadAttempted && (uploadedCount === 0 || uploadSkipped.length > 0);
    if (
      uploadFailed ||
      (uploadedCount === 0 && deletions.length === 0 && unreadableSkipCount === 0)
    ) {
      const detail = skipped.map((s) => `${s.syncKey}: ${s.reason}`).join("; ");
      const message =
        uploadedCount === 0 && deletedCount === 0
          ? `Push to ${destinationLabel} failed: no files uploaded.${detail ? ` Skipped: ${detail}` : ""}`
          : `Push to ${destinationLabel} failed: partial upload (${uploadedCount} uploaded). Skipped: ${detail}. Remote /configs metadata was not updated.`;
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

    const mergedManifestFiles: Manifest["files"] = { ...remoteManifestFiles };
    for (const key of uploadedKeys) {
      mergedManifestFiles[key] = localPayload.manifest.files[key]!;
    }
    for (const key of deletions) {
      delete mergedManifestFiles[key];
    }

    const uploadedFiles: Record<string, AppConfigsPayloadFile> = {};
    for (const key of uploadedKeys) {
      uploadedFiles[key] = localPayload.files[key]!;
    }
    for (const key of Object.keys(mergedManifestFiles)) {
      if (uploadedFiles[key]) {
        continue;
      }
      const remoteEntry = remoteManifestFiles[key];
      if (remoteEntry) {
        uploadedFiles[key] = {
          checksum: remoteEntry.checksum,
          sizeBytes: remoteEntry.sizeBytes,
          ...(remoteEntry.encoding ? { encoding: remoteEntry.encoding } : {}),
        };
      }
    }

    const metadataPayload = buildMetadataOnlyPayload(
      { ...localPayload.manifest, files: mergedManifestFiles },
      uploadedFiles
    );
    const result = await putAppConfigs(context, metadataPayload, { trigger });
    if (!result) {
      return false;
    }

    for (const syncKey of deletions) {
      try {
        const status = await deleteR2Object(credentials, syncKey);
        deletedCount += 1;
        deletedKeys.push(syncKey);
        logger.appendLine(
          `[${new Date().toISOString()}] Deleted remote object ${syncKey} status=${status}`
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ syncKey, reason });
        logger.appendLine(
          `[${new Date().toISOString()}] Delete failed ${syncKey}: ${reason}`
        );
      }
    }

    if (deletions.length > 0 && deletedCount !== deletions.length) {
      const detail = skipped.map((s) => `${s.syncKey}: ${s.reason}`).join("; ");
      const message = `Push to ${destinationLabel} partial: manifest updated but remote delete failed (${deletedCount}/${deletions.length}). ${detail}`;
      logger.appendLine(`[${new Date().toISOString()}] ${message}`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: uploadedCount + deletedCount,
        success: true,
        partial: true,
        destination,
        error: message,
      });
      vscode.window.showWarningMessage(message);
      return false;
    }

    const session = await getAppSession(context);
    if (session) {
      const localChecksums = (await scanLocalAppConfigFiles(context)).checksums;
      const remoteChecksums: Record<string, string> = {};
      for (const [key, entry] of Object.entries(mergedManifestFiles)) {
        remoteChecksums[key] = entry.checksum;
      }
      await updateAppStorageBaselineAfterSync(context, {
        accountKey: appStorageAccountKey(session, getAppApiUrl()),
        destination,
        remoteUpdatedAt: result.updated_at,
        syncedKeys: [...uploadedKeys, ...deletedKeys],
        deletedKeys: deletedKeys,
        localChecksums,
        remoteChecksums,
        trackingScope: buildTrackingScopeForBaseline(context),
      });
    }

    const totalChanged = uploadedCount + deletedCount;
    const pushPartial = unreadableSkipCount > 0 && uploadSet.size > 0;
    const totalIntended = uploadedCount + unreadableSkipCount;
    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "push",
      trigger,
      fileCount: totalChanged,
      success: true,
      partial: pushPartial,
      destination,
      ...(pushPartial
        ? {
            error: `Pushed ${uploadedCount} of ${totalIntended}, ${unreadableSkipCount} unreadable`,
          }
        : {}),
    });
    if (pushPartial) {
      vscode.window.showWarningMessage(
        formatPushPartialToast(
          uploadedCount,
          totalIntended,
          unreadableSkipCount,
          destination
        )
      );
    } else if (uploadedCount > 0) {
      vscode.window.showInformationMessage(
        formatPushSuccessToast(uploadedCount, destination)
      );
    } else if (deletedCount > 0) {
      vscode.window.showInformationMessage(
        formatPushRemovalToast(deletedCount, destination)
      );
    }
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs succeeded: ${uploadedCount} files`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs failed: ${message}`
    );
    if (!isAppConfigsFetchError(err)?.historyRecorded) {
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "push",
        trigger,
        fileCount: 0,
        success: false,
        destination,
        error: message,
      });
    }
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
    const response = await fetchAppConfigs(context, { trigger });
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

    const { manifest } = response.payload;
    const roots = resolveSyncRoots(process.platform, context);
    const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> =
      [];
    const keyFilter = options?.keys ? new Set(options.keys) : undefined;
    const missingRemoteKeys: string[] = [];
    const reconciledKeys: string[] = [];
    let pullCandidates = 0;

    const sessionForBaseline = await getAppSession(context);
    const pullBaseline = sessionForBaseline
      ? await loadAppStorageBaseline(
          context,
          appStorageAccountKey(sessionForBaseline, getAppApiUrl()),
          destination,
          sessionForBaseline
        )
      : undefined;

    for (const [syncKey, manifestEntry] of Object.entries(manifest.files)) {
      if (keyFilter && !keyFilter.has(syncKey)) {
        continue;
      }

      const file = response.payload.files[syncKey];
      if (!file) {
        continue;
      }

      const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
      if (!absolutePath) {
        continue;
      }

      let localChecksum: string | undefined;
      try {
        const localBuf = await fs.readFile(absolutePath);
        localChecksum = computeChecksum(localBuf);
      } catch {
        localChecksum = undefined;
      }

      if (!shouldPullAppConfigFile(localChecksum, manifestEntry.checksum)) {
        reconciledKeys.push(syncKey);
        continue;
      }

      pullCandidates += 1;

      const content = await resolveRemoteFileContent(
        context,
        syncKey,
        file,
        manifestEntry
      );
      if (!content) {
        missingRemoteKeys.push(syncKey);
        continue;
      }

      if (computeChecksum(content) === localChecksum) {
        reconciledKeys.push(syncKey);
        continue;
      }

      filesToWrite.push({
        absolutePath,
        syncKey,
        content,
      });
    }

    const remoteDeletions = options?.remoteDeletions ?? [];
    const filesToDelete: Array<{ absolutePath: string; syncKey: string }> = [];
    for (const syncKey of remoteDeletions) {
      const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
      if (absolutePath) {
        filesToDelete.push({ absolutePath, syncKey });
      }
    }

    const config = vscode.workspace.getConfiguration("cursorSync");
    const safeMode = config.get<boolean>("safeMode") ?? true;

    if (safeMode && filesToWrite.length > 0) {
      const items = filesToWrite.map((f) => ({
        label: f.syncKey,
        picked: !pullBaseline || !baselineKeyTracked(pullBaseline, f.syncKey),
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

    if (safeMode && filesToDelete.length > 0) {
      const items = filesToDelete.map((f) => ({
        label: f.syncKey,
        picked: false,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Cursor Sync storage: files to remove locally",
        placeHolder: "Deselect files you want to keep on this machine",
      });
      if (!selected) {
        logger.appendLine(`[${new Date().toISOString()}] Pull app configs cancelled by user`);
        return false;
      }
      const selectedKeys = new Set(selected.map((s) => s.label));
      const filteredDeletes = filesToDelete.filter((f) => selectedKeys.has(f.syncKey));
      filesToDelete.length = 0;
      filesToDelete.push(...filteredDeletes);
    }

    if (filesToWrite.length === 0 && filesToDelete.length === 0) {
      if (sessionForBaseline && reconciledKeys.length > 0) {
        const localChecksums = (await scanLocalAppConfigFiles(context)).checksums;
        const remoteChecksums: Record<string, string> = {};
        for (const [key, entry] of Object.entries(manifest.files)) {
          remoteChecksums[key] = entry.checksum;
        }
        await updateAppStorageBaselineAfterSync(context, {
          accountKey: appStorageAccountKey(sessionForBaseline, getAppApiUrl()),
          destination,
          remoteUpdatedAt: response.updated_at,
          syncedKeys: reconciledKeys,
          deletedKeys: [],
          localChecksums,
          remoteChecksums,
          trackingScope: buildTrackingScopeForBaseline(context),
        });
      }
      vscode.window.showInformationMessage(formatPullEmptyToast(destination));
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return true;
    }

    const pathsNeedingBackup = [
      ...filesToWrite.map((f) => f.absolutePath),
      ...filesToDelete.map((f) => f.absolutePath),
    ];
    const { entries: backupEntries } = await createBackup(context, pathsNeedingBackup);

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

    const deletedLocally: string[] = [];
    for (const file of filesToDelete) {
      try {
        await fs.unlink(file.absolutePath);
        deletedLocally.push(file.syncKey);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger.appendLine(
            `[${new Date().toISOString()}] Pull app configs delete failed for ${file.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
          );
          await rollbackFromBackup(writtenBackups);
          const deleteErrorMessage = `Pull from ${destinationLabel} failed: could not remove local file. Changes have been rolled back.`;
          await addSyncHistoryEntry(context, {
            timestamp: new Date().toISOString(),
            direction: "pull",
            trigger,
            fileCount: 0,
            success: false,
            destination,
            error: deleteErrorMessage,
          });
          vscode.window.showErrorMessage(deleteErrorMessage);
          return false;
        }
        deletedLocally.push(file.syncKey);
      }
    }

    await pruneOldBackups(context);

    const session = await getAppSession(context);
    const wroteCount = filesToWrite.length;
    const totalPulled = wroteCount + deletedLocally.length;
    const pullPartial = missingRemoteKeys.length > 0;
    const pullTotalExpected = pullCandidates + deletedLocally.length;
    const baselineSyncedKeys = [
      ...new Set([
        ...reconciledKeys,
        ...filesToWrite.map((f) => f.syncKey),
      ]),
    ];
    if (session) {
      const localChecksums = (await scanLocalAppConfigFiles(context)).checksums;
      const remoteChecksums: Record<string, string> = {};
      for (const [key, entry] of Object.entries(manifest.files)) {
        remoteChecksums[key] = entry.checksum;
      }
      await updateAppStorageBaselineAfterSync(context, {
        accountKey: appStorageAccountKey(session, getAppApiUrl()),
        destination,
        remoteUpdatedAt: response.updated_at,
        syncedKeys: baselineSyncedKeys,
        deletedKeys: deletedLocally,
        localChecksums,
        remoteChecksums,
        trackingScope: buildTrackingScopeForBaseline(context),
      });
    }

    await addSyncHistoryEntry(context, {
      timestamp: new Date().toISOString(),
      direction: "pull",
      trigger,
      fileCount: totalPulled,
      success: !pullPartial,
      partial: pullPartial,
      destination,
      ...(pullPartial
        ? {
            error: formatPullPartialToast(
              totalPulled,
              pullTotalExpected,
              missingRemoteKeys.length,
              destination
            ),
          }
        : {}),
    });
    if (pullPartial) {
      vscode.window.showWarningMessage(
        formatPullPartialToast(
          totalPulled,
          pullTotalExpected,
          missingRemoteKeys.length,
          destination
        )
      );
    } else if (totalPulled > 0) {
      vscode.window.showInformationMessage(
        formatPullSuccessToast(totalPulled, destination, {
          wroteFiles: wroteCount,
          deletedLocally: deletedLocally.length,
        })
      );
    }
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs ${pullPartial ? "partial" : "succeeded"}: ${totalPulled} files`
    );
    return !pullPartial;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs failed: ${message}`
    );
    if (!isAppConfigsFetchError(err)?.historyRecorded) {
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        destination,
        error: message,
      });
    }
    vscode.window.showErrorMessage(`Pull from ${destinationLabel} failed: ${message}`);
    return false;
  }
}
