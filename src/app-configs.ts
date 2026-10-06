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
  type LocalConfigFileScan,
} from "./app-config-local-scan.js";
import { nodePlatform } from "./os-runtime.js";
import { AppConfigsFetchError, isAppConfigsFetchError } from "./app-config-fetch-errors.js";
import { syncKeyRootPrefix } from "./app-config-sync-root-keys.js";
import {
  clearSchedulerMassDeleteBlockIfResolved,
  resetSchedulerMassDeleteBlockDedupe,
  evaluateEmptyRemoteManifestLocalDeletes,
  evaluateRemoteDeleteBatch,
  recordSchedulerMassDeleteBlock,
  resolveMassDeleteBatch,
  syncEvaluatedMassDeleteBlockState,
  formatPerFileSyncHeldNotice,
  formatPullHeldRemoteUpdateNotice,
  formatPullSkippedFilesNotice,
  formatSyncRootDeleteHeldNotice,
  listPerFileHeldSyncKeys,
  perFileHeldReasonForKey,
  type PullSkipReasonOverrides,
} from "./app-storage-delete-guard.js";
import { shouldRecordConflictWarning } from "./app-storage-conflict-dedupe.js";
import {
  assertSafeLocalDeleteTarget,
  assertSafePullTarget,
  ensureSyncRootsForFreshPull,
  removeEmptyParentDirsWithinRoot,
  resolveSyncRootsRealpaths,
  scanWithDiskProbes,
  syncKeyUnderFailedRoot,
  syncRootRealForKey,
  type SyncRootEnsureFailure,
  writeFileWithoutFollow,
} from "./app-config-disk-probe.js";
import {
  clearSyncDeclines,
  filterPushKeysRespectingDeclines,
  loadSyncDeclineStore,
  pruneResolvedDeclines,
  recordDeclinedLocalDelete,
  recordDeclinedPullOverwrite,
} from "./app-storage-sync-declines.js";
import {
  isLocallyAbsentSafeToPull,
  shouldAllowPullWriteForKey,
} from "./app-storage-sync-decisions.js";
import {
  alignGeneratedOnlyLocalChecksums,
  GENERATED_EXTENSIONS_SYNC_KEY,
} from "./app-config-extensions-align.js";
import {
  appStorageSyncActionFromClassification,
  baselineHasEntries,
  classifyAppStorageKeys,
  filterScheduledAppStoragePullKeys,
  pullOverwriteShouldBePreselected,
  loadAppStorageBaseline,
  needsPullAppConfigFile,
  remoteChecksumChangedSinceBaseline,
  shouldPullAppConfigFile,
  updateAppStorageBaselineAfterSync,
} from "./app-storage-baseline.js";

/** Pull completed cleanly; held = scheduled root hold (not a failure); failure = error or partial. */
export type AppStoragePullStatus = "success" | "held" | "failure";
import {
  enumerateSyncFiles,
  listSymlinkSyncKeysUnderRoots,
  resolveSyncRoots,
  syncKeyToAbsolutePath,
} from "./paths.js";
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

  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    const message = `Failed to fetch app configs (${response.status})${bodyText ? `: ${bodyText}` : ""}`;
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

  return JSON.parse(bodyText) as AppConfigsResponse;
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

  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `Failed to push app configs (${response.status})${bodyText ? `: ${bodyText}` : ""}`
    );
  }

  return JSON.parse(bodyText) as AppConfigsResponse;
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
  const roots = resolveSyncRoots(nodePlatform(), context);
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
  const roots = resolveSyncRoots(nodePlatform(), context);
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

function finalizeAppStorageSyncAction(
  action: AppStorageSyncAction,
  scan: LocalConfigFileScan,
  perFileHeldKeys?: string[]
): AppStorageSyncAction {
  if (action.action !== "none") {
    return action;
  }
  if (
    !scan.deletesAllowed &&
    (scan.deleteBlockedRootPrefixes.size > 0 || scan.deleteBlockReason)
  ) {
    return {
      action: "blocked",
      message: formatSyncRootDeleteHeldNotice(scan),
    };
  }
  if (perFileHeldKeys && perFileHeldKeys.length > 0) {
    return {
      action: "blocked",
      message: formatPerFileSyncHeldNotice(scan, perFileHeldKeys),
    };
  }
  return action;
}

function preferEmptyScanHoldOverBaselineRefresh(
  action: AppStorageSyncAction,
  scan: LocalConfigFileScan,
  perFileHeldKeys: string[]
): AppStorageSyncAction {
  if (action.action !== "baseline_refresh") {
    return action;
  }
  const held = finalizeAppStorageSyncAction(
    { action: "none" },
    scan,
    perFileHeldKeys
  );
  if (held.action === "blocked") {
    return held;
  }
  return action;
}

export async function clearScheduledRootHeldMarkers(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(ROOT_ENSURE_WARN_STATE_KEY, []);
  await context.globalState.update(SCHEDULED_ROOT_HELD_HISTORY_KEY, undefined);
}

function collectPushDiskProbeKeys(input: {
  localManifestKeys: string[];
  baselineLocalKeys: string[];
  remoteManifestKeys: string[];
  keysToUpload: string[];
  deletions: string[];
  explicitKeys?: string[];
  skippedReadKeys: string[];
  localDiskKeys: string[];
}): string[] {
  const set = new Set<string>();
  for (const k of input.keysToUpload) {
    set.add(k);
  }
  for (const k of input.deletions) {
    set.add(k);
  }
  if (input.explicitKeys) {
    for (const k of input.explicitKeys) {
      set.add(k);
    }
  }
  for (const k of input.localManifestKeys) {
    set.add(k);
  }
  for (const k of input.baselineLocalKeys) {
    set.add(k);
  }
  for (const k of input.remoteManifestKeys) {
    set.add(k);
  }
  for (const k of input.skippedReadKeys) {
    set.add(k);
  }
  for (const k of input.localDiskKeys) {
    set.add(k);
  }
  return [...set];
}

const ROOT_ENSURE_WARN_STATE_KEY = "cursorSync.appStorage.rootEnsureFailuresWarned";

type RootEnsureWarnEntry = { rootPath: string; fingerprint: string };

const SCHEDULED_ROOT_HELD_HISTORY_KEY = "cursorSync.appStorage.scheduledRootHeldHistory";

async function warnRootEnsureFailuresOnce(
  context: vscode.ExtensionContext,
  failures: Array<{ rootPath: string; message: string }>,
  trigger: AppConfigsSyncTrigger,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  if (failures.length === 0) {
    const prior =
      context.globalState.get<RootEnsureWarnEntry[]>(ROOT_ENSURE_WARN_STATE_KEY) ?? [];
    if (prior.length > 0) {
      await context.globalState.update(ROOT_ENSURE_WARN_STATE_KEY, []);
      await context.globalState.update(SCHEDULED_ROOT_HELD_HISTORY_KEY, undefined);
    }
    return;
  }
  const next: RootEnsureWarnEntry[] = failures.map((f) => ({
    rootPath: f.rootPath,
    fingerprint: f.message,
  }));
  if (trigger === "scheduled") {
    await context.globalState.update(ROOT_ENSURE_WARN_STATE_KEY, next);
  } else {
    const roots = failures.map((f) => f.rootPath).join(", ");
    const detail = failures[0]?.message ?? "";
    vscode.window.showWarningMessage(
      `Pull skipped sync root(s): ${roots}. ${detail}`
    );
    await context.globalState.update(ROOT_ENSURE_WARN_STATE_KEY, next);
  }
  for (const failure of failures) {
    logger.appendLine(
      `[${new Date().toISOString()}] Pull skipped sync root ${failure.rootPath}: ${failure.message}`
    );
  }
}

function isScheduledRootOnlyPullSkip(
  scan: LocalConfigFileScan,
  skippedKeys: string[],
  rootEnsureFailures: SyncRootEnsureFailure[]
): boolean {
  if (
    scan.deleteBlockedRootPrefixes.size === 0 &&
    rootEnsureFailures.length === 0
  ) {
    return false;
  }
  if (skippedKeys.length === 0) {
    return true;
  }
  return skippedKeys.every((key) => {
    const reason = perFileHeldReasonForKey(key, scan);
    if (reason !== "unsafe_path") {
      return false;
    }
    const prefix = syncKeyRootPrefix(key);
    if (prefix && scan.deleteBlockedRootPrefixes.has(prefix)) {
      return true;
    }
    return syncKeyUnderFailedRoot(key, rootEnsureFailures) !== undefined;
  });
}

async function recordScheduledRootHeldPullOnce(
  context: vscode.ExtensionContext,
  trigger: AppConfigsSyncTrigger,
  fingerprint: string,
  message: string
): Promise<void> {
  if (trigger !== "scheduled") {
    return;
  }
  const prev = context.globalState.get<string>(SCHEDULED_ROOT_HELD_HISTORY_KEY);
  if (prev === fingerprint) {
    return;
  }
  await context.globalState.update(SCHEDULED_ROOT_HELD_HISTORY_KEY, fingerprint);
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: 0,
    success: true,
    destination: "cursor-sync-storage",
    error: `held: ${message}`,
  });
}

function describePushSkipLabel(
  syncKey: string,
  scan: LocalConfigFileScan,
  trackedManifestKeys: Set<string>
): string {
  const reason = perFileHeldReasonForKey(syncKey, scan);
  if (reason === "symlink" && !trackedManifestKeys.has(syncKey)) {
    return `${syncKey} (never-synced symlink)`;
  }
  if (reason === "symlink") {
    return `${syncKey} (symlink)`;
  }
  if (reason === "under_symlinked_dir") {
    const folder = scan.symlinkedFolderLabels?.[syncKey] ?? "unknown";
    return `${syncKey} (inside symlinked folder ${folder})`;
  }
  if (reason === "unreadable") {
    return `${syncKey} (unreadable)`;
  }
  if (reason === "excluded") {
    return `${syncKey} (excluded)`;
  }
  if (reason === "oversize") {
    return `${syncKey} (oversize)`;
  }
  return `${syncKey} (${reason.replace("_", " ")})`;
}

function formatManualPushResultToast(
  uploadedCount: number,
  deletedCount: number,
  destination: "cursor-sync-storage",
  skipLabels: string[],
  probedScan: LocalConfigFileScan,
  destinationLabel: string,
  trackedManifestKeys: Set<string>
): string | undefined {
  const parts: string[] = [];
  if (uploadedCount > 0) {
    parts.push(`Pushed ${uploadedCount} file(s) to ${destinationLabel}`);
  } else if (deletedCount > 0) {
    parts.push(`Removed ${deletedCount} file(s) from ${destinationLabel}`);
  }
  if (skipLabels.length > 0) {
    const described = skipLabels.map((k) =>
      describePushSkipLabel(k, probedScan, trackedManifestKeys)
    );
    const preview = described.slice(0, 3).join(", ");
    const suffix = skipLabels.length > 3 ? ` (+${skipLabels.length - 3} more)` : "";
    const onlyNeverSyncedSymlinks = skipLabels.every(
      (k) => (probedScan.symlinkKeys?.has(k) ?? false) && !trackedManifestKeys.has(k)
    );
    if (onlyNeverSyncedSymlinks) {
      parts.push(
        `skipped ${skipLabels.length} never-synced symlink(s): ${preview}${suffix}`
      );
    } else {
      parts.push(`skipped ${skipLabels.length}: ${preview}${suffix}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(", ");
}

function pushSkipToastIsInformational(
  skipLabels: string[],
  scan: LocalConfigFileScan,
  trackedManifestKeys: Set<string>
): boolean {
  return (
    skipLabels.length > 0 &&
    skipLabels.every(
      (k) => (scan.symlinkKeys?.has(k) ?? false) && !trackedManifestKeys.has(k)
    )
  );
}

export type AppStorageSyncAction =
  | { action: "none" }
  | { action: "blocked"; message: string }
  | { action: "pull"; keys: string[]; remoteDeletions: string[] }
  | { action: "push"; keys: string[]; deletions: string[] }
  | {
      action: "pull-push";
      pullKeys: string[];
      remoteDeletions: string[];
      pushKeys: string[];
      deletions: string[];
    }
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

  const roots = resolveSyncRoots(nodePlatform(), context);
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

  const probeKeys = new Set([
    ...Object.keys(remoteChecksums),
    ...Object.keys(baseline?.localChecksums ?? {}),
    ...Object.keys(baseline?.remoteChecksums ?? {}),
    ...Object.keys(localChecksums),
  ]);
  const baselineLocalKeys = baseline ? Object.keys(baseline.localChecksums) : [];
  const probedScan = await scanWithDiskProbes(context, localScan, probeKeys, {
    baselineLocalKeys,
  });

  localChecksums = alignGeneratedOnlyLocalChecksums(
    localChecksums,
    remoteChecksums,
    baseline,
    extensionsEmpty
  );

  const declineStore = await loadSyncDeclineStore(context);
  const classified = classifyAppStorageKeys(
    localChecksums,
    remoteChecksums,
    baseline,
    probedScan,
    declineStore
  );
  const derived = appStorageSyncActionFromClassification(
    classified,
    remoteChecksums
  );
  const perFileHeldKeys = listPerFileHeldSyncKeys(
    probedScan,
    localChecksums,
    remoteChecksums
  );

  const trackedCountForBlock = baseline
    ? Object.keys(baseline.localChecksums).length
    : 0;
  const blockPushDeletes = classified.deleteKeys.filter((k) =>
    probedScan.provablyAbsentKeys.has(k)
  );
  const blockPullDeletes = classified.remoteDeleteKeys;
  syncEvaluatedMassDeleteBlockState(
    blockPushDeletes.length > 0 ? blockPushDeletes : blockPullDeletes,
    trackedCountForBlock,
    probedScan
  );

  if (derived.action === "pull-push") {
    let pullKeys = derived.pullKeys;
    if (trigger === "scheduled") {
      pullKeys = filterScheduledAppStoragePullKeys(
        pullKeys,
        baseline,
        probedScan,
        remoteChecksums
      );
    }
    let remoteDeletions = [...derived.remoteDeletions];
    const build = await buildLocalAppConfigsPayload(context);
    let pushKeys = derived.pushKeys.filter(
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
    pushKeys = pushKeys.filter(
      (k) =>
        !probedScan.skippedUnknownKeys.has(k) && !probedScan.untrackedKeys.has(k)
    );
    let deletions = derived.deletions.filter((k) =>
      probedScan.provablyAbsentKeys.has(k)
    );
    if (!probedScan.deletesAllowed) {
      deletions = [];
    }
    return {
      action: "pull-push",
      pullKeys,
      remoteDeletions,
      pushKeys,
      deletions,
    };
  }

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
    pushKeys = pushKeys.filter(
      (k) =>
        !probedScan.skippedUnknownKeys.has(k) && !probedScan.untrackedKeys.has(k)
    );
    let deletions = derived.deletions.filter((k) =>
      probedScan.provablyAbsentKeys.has(k)
    );
    if (!probedScan.deletesAllowed) {
      deletions = [];
    }
    const trackedCount = baseline
      ? Object.keys(baseline.localChecksums).length
      : 0;
    const deleteDecision = evaluateRemoteDeleteBatch(
      deletions,
      trackedCount,
      trigger,
      probedScan
    );
    if (deleteDecision.schedulerBlocked && deletions.length > 0) {
      const reason = deleteDecision.reason ?? "Scheduled delete blocked";
      const recorded = await recordSchedulerMassDeleteBlock(
        context,
        trigger,
        "push",
        reason,
        deletions,
        addSyncHistoryEntry
      );
      if (recorded) {
        void vscode.window.showWarningMessage(reason);
      }
      deletions = [];
    }
    if (pushKeys.length === 0 && deletions.length === 0) {
      if (classified.baselineRefreshKeys.length > 0) {
        return preferEmptyScanHoldOverBaselineRefresh(
          { action: "baseline_refresh", keys: classified.baselineRefreshKeys },
          probedScan,
          perFileHeldKeys
        );
      }
      return finalizeAppStorageSyncAction(
        { action: "none" },
        probedScan,
        perFileHeldKeys
      );
    }
    return { action: "push", keys: pushKeys, deletions };
  }

  if (derived.action === "baseline_refresh") {
    return preferEmptyScanHoldOverBaselineRefresh(
      { action: "baseline_refresh", keys: derived.keys },
      probedScan,
      perFileHeldKeys
    );
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
        probedScan,
        remoteChecksums
      );
    }
    let remoteDeletions = [...derived.remoteDeletions];
    const emptyRemotePull = evaluateEmptyRemoteManifestLocalDeletes(
      Object.keys(remoteChecksums).length,
      baseline,
      remoteDeletions
    );
    if (emptyRemotePull.blocked && remoteDeletions.length > 0) {
      const reason = emptyRemotePull.reason ?? "Empty remote manifest";
      if (trigger === "scheduled") {
        const recorded = await recordSchedulerMassDeleteBlock(
          context,
          trigger,
          "pull",
          reason,
          remoteDeletions,
          addSyncHistoryEntry
        );
        if (recorded) {
          void vscode.window.showWarningMessage(reason);
        }
      } else {
        await addSyncHistoryEntry(context, {
          timestamp: new Date().toISOString(),
          direction: "pull",
          trigger,
          fileCount: 0,
          success: false,
          destination: "cursor-sync-storage",
          error: reason,
        });
        return { action: "blocked", message: reason };
      }
      remoteDeletions = [];
    }
    const trackedCountPull = baseline
      ? Object.keys(baseline.localChecksums).length
      : 0;
    const pullDeleteDecision = evaluateRemoteDeleteBatch(
      remoteDeletions,
      trackedCountPull,
      trigger,
      probedScan
    );
    if (pullDeleteDecision.schedulerBlocked && remoteDeletions.length > 0) {
      const reason =
        pullDeleteDecision.reason ?? "Scheduled local delete blocked";
      const recorded = await recordSchedulerMassDeleteBlock(
        context,
        trigger,
        "pull",
        reason,
        remoteDeletions,
        addSyncHistoryEntry
      );
      if (recorded) {
        void vscode.window.showWarningMessage(reason);
      }
      remoteDeletions = [];
    }
    if (pullKeys.length === 0 && remoteDeletions.length === 0) {
      return finalizeAppStorageSyncAction(
        { action: "none" },
        probedScan,
        perFileHeldKeys
      );
    }
    return {
      action: "pull",
      keys: pullKeys,
      remoteDeletions,
    };
  }

  return finalizeAppStorageSyncAction(
    { action: "none" },
    probedScan,
    perFileHeldKeys
  );
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
  if (shouldRecordConflictWarning(keys)) {
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
  }
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
    const localChecksumsForDecline = await computeLocalAppConfigChecksums(context);
    await pruneResolvedDeclines(context, localChecksumsForDecline);
    const explicitPush =
      options?.keys !== undefined || trigger === "manual" || trigger === "syncNow";
    let keysToUpload =
      options?.keys ??
      Object.keys(localPayload.files).filter(
        (k) => !isGeneratedOnlyAppConfigKey(k, localPayload)
      );
    keysToUpload = await filterPushKeysRespectingDeclines(
      context,
      keysToUpload,
      localChecksumsForDecline,
      trigger,
      explicitPush
    );
    let deletions = [...(options?.deletions ?? [])];
    const explicitDeletionKeys = new Set(options?.deletions ?? []);

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
    let pushCancelledByUser = false;
    const initialDeletionCount = deletions.length;
    if (safeMode && deletions.length > 0) {
      const items = deletions.map((key) => ({ label: key, picked: false }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Cursor Sync storage: files to remove from remote",
        placeHolder: "Select files to remove from the server",
      });
      if (!selected) {
        pushCancelledByUser = true;
        deletions.length = 0;
      } else {
        const allowed = new Set(selected.map((s) => s.label));
        for (let i = deletions.length - 1; i >= 0; i--) {
          if (!allowed.has(deletions[i]!)) {
            deletions.splice(i, 1);
          }
        }
        if (initialDeletionCount > 0 && deletions.length === 0) {
          pushCancelledByUser = true;
        }
      }
    }

    const baselineLocalKeysEarly = baselineEarly
      ? Object.keys(baselineEarly.localChecksums)
      : [];
    const pushScan = await scanLocalAppConfigFiles(context, baselineEarly);
    const symlinkProbeKeys = await listSymlinkSyncKeysUnderRoots(context, roots);
    const pushDiskProbeKeys = collectPushDiskProbeKeys({
      localManifestKeys: Object.keys(localPayload.manifest.files),
      baselineLocalKeys: baselineLocalKeysEarly,
      remoteManifestKeys: Object.keys(remoteManifestFiles),
      keysToUpload,
      deletions,
      explicitKeys: options?.keys,
      skippedReadKeys: skippedReads.map((s) => s.relativeSyncKey),
      localDiskKeys: [
        ...pushScan.skippedUnknownKeys,
        ...pushScan.unreadableKeys,
        ...(pushScan.symlinkKeys ?? []),
        ...(pushScan.excludedKeys ?? []),
        ...(pushScan.oversizeKeys ?? []),
        ...symlinkProbeKeys,
        ...Object.keys(pushScan.checksums),
      ],
    });
    const probedPushScan = await scanWithDiskProbes(context, pushScan, pushDiskProbeKeys, {
      baselineLocalKeys: baselineLocalKeysEarly,
    });
    keysToUpload = keysToUpload.filter(
      (k) =>
        !probedPushScan.skippedUnknownKeys.has(k) &&
        !probedPushScan.untrackedKeys.has(k)
    );
    const deletionsDroppedRecreated: string[] = [];
    for (let i = deletions.length - 1; i >= 0; i--) {
      const deletionKey = deletions[i]!;
      if (
        explicitDeletionKeys.has(deletionKey) &&
        trigger !== "syncNow" &&
        trigger !== "scheduled"
      ) {
        continue;
      }
      if (!probedPushScan.provablyAbsentKeys.has(deletionKey)) {
        deletionsDroppedRecreated.push(deletionKey);
        deletions.splice(i, 1);
      }
    }
    const trackedForDelete = baselineEarly
      ? Object.keys(baselineEarly.localChecksums).length
      : 0;
    const deletionsBeforeMassGuard = [...deletions];
    const confirmedDeletions = await resolveMassDeleteBatch(
      [...deletions],
      trackedForDelete,
      trigger,
      probedPushScan,
      {
        direction: "push",
        modalConfirm: async (reason) => {
          const confirm = await vscode.window.showWarningMessage(
            reason,
            { modal: true },
            "Delete remotely",
            "Cancel"
          );
          return confirm === "Delete remotely";
        },
      }
    );
    if (
      confirmedDeletions.length === 0 &&
      deletionsBeforeMassGuard.length > 0 &&
      evaluateRemoteDeleteBatch(
        deletionsBeforeMassGuard,
        trackedForDelete,
        trigger,
        probedPushScan
      ).needsModalConfirm
    ) {
      pushCancelledByUser = true;
    }
    deletions = [...confirmedDeletions];
    clearSchedulerMassDeleteBlockIfResolved(deletions);

    if (
      pushCancelledByUser &&
      keysToUpload.length === 0 &&
      deletions.length === 0
    ) {
      vscode.window.showInformationMessage(
        `Push to ${destinationLabel} cancelled. Nothing was changed.`
      );
      return false;
    }

    if (
      keysToUpload.length === 0 &&
      deletions.length === 0 &&
      deletionsDroppedRecreated.length > 0 &&
      !pushCancelledByUser
    ) {
      const preview = deletionsDroppedRecreated.slice(0, 2).join(", ");
      const suffix =
        deletionsDroppedRecreated.length > 2
          ? ` (+${deletionsDroppedRecreated.length - 2} more)`
          : "";
      const message =
        deletionsDroppedRecreated.length === 1
          ? `${preview} was recreated locally, so it was not deleted remotely.`
          : `${deletionsDroppedRecreated.length} file(s) were recreated locally (${preview}${suffix}), so they were not deleted remotely.`;
      vscode.window.showInformationMessage(message);
      logger.appendLine(`[${new Date().toISOString()}] Push: ${message}`);
      return true;
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
      uploadedCount === 0 &&
      deletions.length === 0 &&
      deletionsBeforeMassGuard.length > 0
    ) {
      const held = evaluateRemoteDeleteBatch(
        deletionsBeforeMassGuard,
        trackedForDelete,
        trigger,
        probedPushScan
      );
      if (held.needsModalConfirm || held.schedulerBlocked) {
        const reason =
          held.reason ??
          "Remote deletes were held by the mass-delete threshold; nothing was uploaded.";
        vscode.window.showWarningMessage(reason);
        return true;
      }
    }
    if (
      uploadFailed ||
      (uploadedCount === 0 &&
        deletions.length === 0 &&
        unreadableSkipCount === 0 &&
        !pushCancelledByUser)
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
      const pushEndScan = await scanLocalAppConfigFiles(context, baselineEarly);
      await updateAppStorageBaselineAfterSync(context, {
        accountKey: appStorageAccountKey(session, getAppApiUrl()),
        destination,
        remoteUpdatedAt: result.updated_at,
        syncedKeys: [...uploadedKeys, ...deletedKeys],
        deletedKeys: deletedKeys,
        localChecksums,
        remoteChecksums,
        trackingScope: buildTrackingScopeForBaseline(context),
        pruneUntrackedKeys: pushEndScan.untrackedKeys,
      });
    }

    await clearSyncDeclines(context, [...uploadedKeys, ...deletedKeys]);
    resetSchedulerMassDeleteBlockDedupe();

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
    const uploadedKeySet = new Set(uploadedKeys);
    const classificationSkipped = pushDiskProbeKeys.filter(
      (k) =>
        !uploadedKeySet.has(k) &&
        (probedPushScan.skippedUnknownKeys.has(k) ||
          probedPushScan.untrackedKeys.has(k) ||
          probedPushScan.unreadableKeys.has(k))
    );
    const symlinkSkips = [...(probedPushScan.symlinkKeys ?? [])].filter(
      (k) => !uploadedKeySet.has(k)
    );
    const skipLabels = [
      ...new Set([
        ...skippedReads
          .map((s) => s.relativeSyncKey)
          .filter((k) => !uploadedKeySet.has(k)),
        ...classificationSkipped,
        ...symlinkSkips,
      ]),
    ];
    const trackedManifestKeys = new Set([
      ...Object.keys(remoteManifestFiles),
      ...Object.keys(baselineEarly?.localChecksums ?? {}),
    ]);
    if (trigger === "manual") {
      const manualToast = formatManualPushResultToast(
        uploadedCount,
        deletedCount,
        destination,
        skipLabels,
        probedPushScan,
        destinationLabel,
        trackedManifestKeys
      );
      if (manualToast) {
        const onlyNeverSyncedSkips =
          skipLabels.length > 0 &&
          pushSkipToastIsInformational(skipLabels, probedPushScan, trackedManifestKeys);
        if (onlyNeverSyncedSkips || (!pushPartial && skipLabels.length === 0)) {
          vscode.window.showInformationMessage(manualToast);
        } else {
          vscode.window.showWarningMessage(manualToast);
        }
      }
    } else if (pushPartial) {
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
        formatPushSuccessToast(uploadedCount, destination, {
          deletedRemotely: deletedCount > 0 ? deletedCount : undefined,
        })
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
): Promise<AppStoragePullStatus> {
  const trigger = options?.trigger ?? "manual";
  const destination = "cursor-sync-storage" as const;
  const destinationLabel = syncDestinationLabel(destination);
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull app configs started`);

  try {
    const response = await fetchAppConfigs(context, { trigger });
    if (!response) {
      return "failure";
    }

    if (!response.payload || !isAppConfigsPayloadV1(response.payload)) {
      const emptyMsg =
        trigger === "manual"
          ? `Pull from ${destinationLabel}: remote manifest is empty.`
          : formatPullEmptyToast(destination);
      if (trigger === "manual") {
        vscode.window.showWarningMessage(emptyMsg);
      } else {
        vscode.window.showInformationMessage(emptyMsg);
      }
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs: empty or invalid payload`
      );
      return "success";
    }

    const { manifest } = response.payload;
    const roots = resolveSyncRoots(nodePlatform(), context);
    const filesToWrite: Array<{
      absolutePath: string;
      syncKey: string;
      content: Buffer;
      localChecksum?: string;
    }> = [];
    const keyFilter = options?.keys ? new Set(options.keys) : undefined;
    const missingRemoteKeys: string[] = [];
    const reconciledKeys: string[] = [];
    const pullRefusedKeys: string[] = [];
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
    let pullLocalScan = await scanLocalAppConfigFiles(context, pullBaseline);
    const manifestKeys = Object.keys(manifest.files);
    pullLocalScan = await scanWithDiskProbes(context, pullLocalScan, manifestKeys, {
      baselineLocalKeys: pullBaseline
        ? Object.keys(pullBaseline.localChecksums)
        : [],
    });

    if (trigger === "scheduled" && pullLocalScan.deleteBlockedRootPrefixes.size > 0) {
      const fp = [...pullLocalScan.deleteBlockedRootPrefixes].sort().join(",");
      await recordScheduledRootHeldPullOnce(
        context,
        trigger,
        `root-held:${fp}`,
        formatSyncRootDeleteHeldNotice(pullLocalScan)
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Scheduled pull held: sync root blocked (${fp})`
      );
      return "held";
    }

    const heldRemoteUpdateKeys: string[] = [];
    const pullSkipReasonOverrides = new Map<string, import("./app-storage-delete-guard.js").PerFileHeldReason>();

    for (const [syncKey, manifestEntry] of Object.entries(manifest.files)) {
      if (keyFilter && !keyFilter.has(syncKey)) {
        continue;
      }
      if (
        trigger === "manual" &&
        syncKey === GENERATED_EXTENSIONS_SYNC_KEY
      ) {
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

      const remoteChangedOnServer = remoteChecksumChangedSinceBaseline(
        syncKey,
        manifestEntry.checksum,
        pullBaseline
      );
      const needsPull = needsPullAppConfigFile(
        syncKey,
        localChecksum,
        manifestEntry.checksum,
        pullBaseline
      );

      if (!shouldAllowPullWriteForKey(syncKey, pullLocalScan)) {
        if (
          localChecksum !== undefined &&
          localChecksum === manifestEntry.checksum
        ) {
          reconciledKeys.push(syncKey);
        } else if (needsPull && remoteChangedOnServer) {
          pullRefusedKeys.push(syncKey);
          heldRemoteUpdateKeys.push(syncKey);
        } else if (!remoteChangedOnServer) {
          reconciledKeys.push(syncKey);
        }
        continue;
      }
      if (
        localChecksum === undefined &&
        !isLocallyAbsentSafeToPull(syncKey, pullLocalScan)
      ) {
        if (needsPull && remoteChangedOnServer) {
          pullRefusedKeys.push(syncKey);
          heldRemoteUpdateKeys.push(syncKey);
        } else if (!remoteChangedOnServer) {
          reconciledKeys.push(syncKey);
        }
        continue;
      }

      if (!needsPull) {
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
        localChecksum,
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
    let pullCancelledByUser = false;

    const pullWriteCandidates = filesToWrite.filter((f) =>
      shouldAllowPullWriteForKey(f.syncKey, pullLocalScan)
    );
    filesToWrite.length = 0;
    filesToWrite.push(...pullWriteCandidates);

    const offeredPullKeys = filesToWrite.map((f) => f.syncKey);
    if (safeMode && filesToWrite.length > 0) {
      const items = filesToWrite.map((f) => ({
        label: f.syncKey,
        picked: pullOverwriteShouldBePreselected(
          f.syncKey,
          pullBaseline,
          f.localChecksum,
          pullLocalScan,
          manifest.files[f.syncKey]?.checksum
        ),
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "Cursor Sync storage: files to overwrite",
        placeHolder: "Deselect files you do not want to overwrite",
      });

      if (!selected) {
        pullCancelledByUser = true;
        for (const f of filesToWrite) {
          await recordDeclinedPullOverwrite(
            context,
            f.syncKey,
            manifest.files[f.syncKey]?.checksum
          );
        }
        filesToWrite.length = 0;
      } else {
        const selectedKeys = new Set(selected.map((s) => s.label));
        for (const f of filesToWrite) {
          if (!selectedKeys.has(f.syncKey)) {
            await recordDeclinedPullOverwrite(
            context,
            f.syncKey,
            manifest.files[f.syncKey]?.checksum
          );
          }
        }
        const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
        filesToWrite.length = 0;
        filesToWrite.push(...filtered);
      }
    }

    const trackedForPullDelete = pullBaseline
      ? Object.keys(pullBaseline.localChecksums).length
      : 0;
    const initialLocalDeletes = filesToDelete.map((f) => f.syncKey);
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
        pullCancelledByUser = true;
        filesToDelete.length = 0;
      } else {
        const selectedKeys = new Set(selected.map((s) => s.label));
        const filteredDeletes = filesToDelete.filter((f) =>
          selectedKeys.has(f.syncKey)
        );
        for (const key of initialLocalDeletes) {
          if (!selectedKeys.has(key)) {
            await recordDeclinedLocalDelete(
              context,
              key,
              pullLocalScan.checksums[key]
            );
          }
        }
        filesToDelete.length = 0;
        filesToDelete.push(...filteredDeletes);
        if (initialLocalDeletes.length > 0 && filesToDelete.length === 0) {
          pullCancelledByUser = true;
        }
      }
    }

    const deleteKeysBeforeMass = filesToDelete.map((f) => f.syncKey);
    const confirmedLocalDeletes = await resolveMassDeleteBatch(
      deleteKeysBeforeMass,
      trackedForPullDelete,
      trigger,
      pullLocalScan,
      {
        direction: "pull",
        modalConfirm: async (reason) => {
          const confirm = await vscode.window.showWarningMessage(
            reason,
            { modal: true },
            "Delete locally",
            "Cancel"
          );
          return confirm === "Delete locally";
        },
      }
    );
    if (
      confirmedLocalDeletes.length === 0 &&
      deleteKeysBeforeMass.length > 0 &&
      evaluateRemoteDeleteBatch(
        deleteKeysBeforeMass,
        trackedForPullDelete,
        trigger,
        pullLocalScan
      ).needsModalConfirm
    ) {
      pullCancelledByUser = true;
    }
    const confirmedDeleteSet = new Set(confirmedLocalDeletes);
    const filteredByMass = filesToDelete.filter((f) =>
      confirmedDeleteSet.has(f.syncKey)
    );
    filesToDelete.length = 0;
    filesToDelete.push(...filteredByMass);

    if (
      pullCancelledByUser &&
      filesToWrite.length === 0 &&
      filesToDelete.length === 0
    ) {
      vscode.window.showInformationMessage(
        `Pull from ${destinationLabel} cancelled. Nothing was changed.`
      );
      logger.appendLine(`[${new Date().toISOString()}] Pull app configs cancelled by user`);
      return "failure";
    }

    if (
      filesToWrite.length === 0 &&
      filesToDelete.length === 0 &&
      pullCandidates > 0 &&
      missingRemoteKeys.length > 0 &&
      missingRemoteKeys.length === pullCandidates
    ) {
      const message = `Pull from ${destinationLabel} failed: none of the selected files were found in storage (${missingRemoteKeys.length} missing).`;
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        destination,
        error: message,
      });
      vscode.window.showErrorMessage(message);
      return "failure";
    }

    if (filesToWrite.length === 0 && filesToDelete.length === 0) {
      if (
        pullLocalScan.deleteBlockedRootPrefixes.size > 0 ||
        heldRemoteUpdateKeys.length > 0
      ) {
        const held =
          pullLocalScan.deleteBlockedRootPrefixes.size > 0
            ? formatSyncRootDeleteHeldNotice(pullLocalScan)
            : trigger === "manual"
              ? formatPullHeldRemoteUpdateNotice(
                  pullLocalScan,
                  heldRemoteUpdateKeys,
                  pullSkipReasonOverrides
                )
              : formatPerFileSyncHeldNotice(pullLocalScan, heldRemoteUpdateKeys);
        if (trigger === "scheduled" && pullLocalScan.deleteBlockedRootPrefixes.size > 0) {
          const fp = [...pullLocalScan.deleteBlockedRootPrefixes].sort().join(",");
          await recordScheduledRootHeldPullOnce(
            context,
            trigger,
            `root-held:${fp}`,
            held
          );
          logger.appendLine(`[${new Date().toISOString()}] Scheduled pull held: ${held}`);
          return "held";
        }
        if (trigger !== "scheduled") {
          vscode.window.showWarningMessage(held);
        }
        logger.appendLine(`[${new Date().toISOString()}] Pull held: ${held}`);
        return "success";
      }
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
      const emptyRemote = manifestKeys.length === 0;
      if (emptyRemote) {
        const emptyMsg =
          trigger === "manual"
            ? `Pull from ${destinationLabel}: remote manifest is empty.`
            : formatPullEmptyToast(destination);
        if (trigger === "manual") {
          vscode.window.showWarningMessage(emptyMsg);
        } else {
          vscode.window.showInformationMessage(emptyMsg);
        }
      } else if (trigger === "manual") {
        vscode.window.showInformationMessage(
          `Pull from ${destinationLabel}: up to date.`
        );
      }
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return "success";
    }

    const pathsNeedingBackup = [
      ...filesToWrite.map((f) => f.absolutePath),
      ...filesToDelete.map((f) => f.absolutePath),
    ];
    const { entries: backupEntries, failedPaths: backupFailedPaths } =
      await createBackup(context, pathsNeedingBackup);
    if (backupFailedPaths.length > 0) {
      const message = `Pull from ${destinationLabel} failed: could not back up ${backupFailedPaths.length} file(s) before writing. Nothing was changed.`;
      logger.appendLine(`[${new Date().toISOString()}] ${message}`);
      await addSyncHistoryEntry(context, {
        timestamp: new Date().toISOString(),
        direction: "pull",
        trigger,
        fileCount: 0,
        success: false,
        destination,
        error: message,
      });
      vscode.window.showErrorMessage(message);
      return "failure";
    }

    const baselineLocalKeys = pullBaseline
      ? Object.keys(pullBaseline.localChecksums)
      : [];
    const rootEnsureFailures = await ensureSyncRootsForFreshPull(
      roots,
      filesToWrite.map((f) => f.syncKey),
      baselineLocalKeys
    );
    const pullResolvedRoots = await resolveSyncRootsRealpaths(roots);

    const pullRootCreateSkipped: string[] = [];
    const writablePullFiles = filesToWrite.filter((file) => {
      const failure = syncKeyUnderFailedRoot(file.syncKey, rootEnsureFailures);
      if (failure) {
        pullRootCreateSkipped.push(file.syncKey);
        logger.appendLine(
          `[${new Date().toISOString()}] Pull skipped ${file.syncKey}: sync root could not be created (${failure.message})`
        );
        return false;
      }
      return true;
    });
    filesToWrite.length = 0;
    filesToWrite.push(...writablePullFiles);

    const writtenBackups: typeof backupEntries = [];
    const pullWriteSkipped: string[] = [];
    let wroteCount = 0;
    for (const file of filesToWrite) {
      try {
        await assertSafePullTarget(file.absolutePath, file.syncKey, pullResolvedRoots);
        await writeFileWithoutFollow(file.absolutePath, file.content, {
          syncKey: file.syncKey,
          resolved: pullResolvedRoots,
        });
        wroteCount += 1;
        const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
        if (backup) {
          writtenBackups.push(backup);
        }
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("changed during write")
        ) {
          pullWriteSkipped.push(file.syncKey);
          pullSkipReasonOverrides.set(file.syncKey, "changed_during_write");
          logger.appendLine(
            `[${new Date().toISOString()}] Pull skipped changed during write ${file.syncKey}: ${err.message}`
          );
          continue;
        }
        if (
          err instanceof Error &&
          (err.message.includes("Unsafe path") ||
            err.message.includes("symlink") ||
            err.message.includes("outside sync root"))
        ) {
          pullWriteSkipped.push(file.syncKey);
          logger.appendLine(
            `[${new Date().toISOString()}] Pull skipped unsafe path ${file.syncKey}: ${err.message}`
          );
          continue;
        }
        pullWriteSkipped.push(file.syncKey);
        logger.appendLine(
          `[${new Date().toISOString()}] Pull skipped write for ${file.syncKey}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }

    const deletedLocally: string[] = [];
    const pullDeleteSkipped: string[] = [];
    for (const file of filesToDelete) {
      try {
        await assertSafeLocalDeleteTarget(
          file.absolutePath,
          file.syncKey,
          pullResolvedRoots
        );
        await fs.unlink(file.absolutePath);
        deletedLocally.push(file.syncKey);
        const rootInfo = syncRootRealForKey(file.syncKey, pullResolvedRoots);
        if (rootInfo) {
          await removeEmptyParentDirsWithinRoot(
            file.absolutePath,
            rootInfo.rootPath,
            rootInfo.rootReal
          );
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("Unsafe delete") ||
            err.message.includes("symlink") ||
            err.message.includes("outside sync root"))
        ) {
          pullDeleteSkipped.push(file.syncKey);
          logger.appendLine(
            `[${new Date().toISOString()}] Pull skipped unsafe delete ${file.syncKey}: ${err.message}`
          );
          continue;
        }
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
          return "failure";
        }
        deletedLocally.push(file.syncKey);
      }
    }

    await pruneOldBackups(context);
    await clearSyncDeclines(context, [
      ...filesToWrite.map((f) => f.syncKey),
      ...deletedLocally,
    ]);
    clearSchedulerMassDeleteBlockIfResolved([]);
    resetSchedulerMassDeleteBlockDedupe();

    const session = await getAppSession(context);
    const pullSkippedKeys = [
      ...new Set([
        ...pullRefusedKeys,
        ...pullWriteSkipped,
        ...pullDeleteSkipped,
        ...pullRootCreateSkipped,
      ]),
    ];
    await warnRootEnsureFailuresOnce(context, rootEnsureFailures, trigger, logger);
    const totalPulled = wroteCount + deletedLocally.length;
    const scheduledRootHeld =
      trigger === "scheduled" &&
      totalPulled === 0 &&
      (pullLocalScan.deleteBlockedRootPrefixes.size > 0 || rootEnsureFailures.length > 0);
    if (scheduledRootHeld) {
      const fp = `ensure:${rootEnsureFailures.map((f) => `${f.rootPath}:${f.message}`).sort().join("|")}`;
      await recordScheduledRootHeldPullOnce(
        context,
        trigger,
        fp,
        rootEnsureFailures[0]?.message ?? "sync root unavailable"
      );
      logger.appendLine(
        `[${new Date().toISOString()}] Scheduled pull held (root ensure failure); no UI toast`
      );
      return "held";
    }
    const pullPartial =
      missingRemoteKeys.length > 0 || pullSkippedKeys.length > 0;
    const pullTotalExpected = pullPartial
      ? totalPulled + pullSkippedKeys.length + missingRemoteKeys.length
      : totalPulled + missingRemoteKeys.length;
    const suppressScheduledPartialUi =
      trigger === "scheduled" &&
      isScheduledRootOnlyPullSkip(pullLocalScan, pullSkippedKeys, rootEnsureFailures);
    const partialToast = formatPullPartialToast(
      totalPulled,
      pullTotalExpected,
      missingRemoteKeys.length,
      destination,
      pullSkippedKeys.length
    );
    const successfulWriteKeys = filesToWrite
      .map((f) => f.syncKey)
      .filter((k) => !pullWriteSkipped.includes(k));
    const baselineSyncedKeys = [
      ...new Set([...reconciledKeys, ...successfulWriteKeys]),
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
        pruneUntrackedKeys: pullLocalScan.untrackedKeys,
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
        ? { error: partialToast }
        : trigger === "scheduled" && totalPulled > 0
          ? { error: `Pulled ${totalPulled} file(s) from storage` }
          : {}),
    });
    if (pullPartial) {
      if (trigger === "scheduled" && totalPulled > 0) {
        vscode.window.showInformationMessage(partialToast);
        const skipNotice = formatPullSkippedFilesNotice(
          pullLocalScan,
          pullSkippedKeys,
          pullSkipReasonOverrides
        );
        if (skipNotice) {
          vscode.window.showInformationMessage(skipNotice);
        }
      } else if (!suppressScheduledPartialUi) {
        vscode.window.showWarningMessage(partialToast);
        const skipNotice = formatPullSkippedFilesNotice(
          pullLocalScan,
          pullSkippedKeys,
          pullSkipReasonOverrides
        );
        if (skipNotice) {
          vscode.window.showWarningMessage(skipNotice);
        }
      }
    } else if (totalPulled > 0 && !pullPartial) {
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
    return pullPartial ? "failure" : "success";
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
    return "failure";
  }
}

/** @internal test hooks */
export const __appConfigsPullTestHooks = {
  warnRootEnsureFailuresOnce,
  isScheduledRootOnlyPullSkip,
};
