import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { getAppSession } from "./app-auth.js";
import {
  applyAppStorageBaselineRefresh,
  clearScheduledRootHeldMarkers,
  determineAppStorageSyncAction,
  fetchAppConfigs,
  notifyAppStorageConflicts,
} from "./app-configs.js";
import { executePush } from "./push.js";
import { executePull } from "./pull.js";
import { isSyncOperationActive } from "./sync-operation.js";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, getLogger, maybeFinalizeAppStorageRecovery } from "./diagnostics.js";
import { refreshSyncStatusBar } from "./sync-status-bar.js";
import { refreshSidebar } from "./sidebar/index.js";
import { executePullSucceeded } from "./pull.js";
import { enumerateSyncFiles } from "./paths.js";
import { computeChecksum } from "./packaging.js";
import { sendEvent } from "./analytics.js";
import {
  buildSyncDebugFailure,
  showSyncFailureWithDebug,
} from "./sync-debug.js";
import type { Manifest } from "./types.js";

const MIN_INTERVAL_MINUTES = 5;
const MAX_JITTER_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let jitterTimeout: ReturnType<typeof setTimeout> | undefined;

function runScheduledTick(context: vscode.ExtensionContext): void {
  void scheduledTick(context).catch((err) => {
    const errMessage = err instanceof Error ? err.message : String(err);
    getLogger().appendLine(
      `[${new Date().toISOString()}] Scheduled sync tick rejected: ${errMessage}`
    );
  });
}

export async function shouldSkipGistPushForAppSession(
  context: vscode.ExtensionContext
): Promise<boolean> {
  return !!(await getAppSession(context));
}

export type SyncAction =
  | { action: "none" }
  | { action: "pull" }
  | { action: "push" }
  | { action: "pull-push" }
  | { action: "conflict"; keys: string[] }
  | { action: "error"; reason: string };

export function startScheduler(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabled = config.get<boolean>("schedule.enabled") ?? true;

  if (!enabled) {
    return;
  }

  const intervalMin = Math.max(
    config.get<number>("schedule.intervalMin") ?? 30,
    MIN_INTERVAL_MINUTES
  );
  const intervalMs = intervalMin * 60 * 1000;
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);

  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Scheduler starting: interval=${intervalMin}min, jitter=${jitter}ms`
  );

  jitterTimeout = setTimeout(() => {
    runScheduledTick(context);
    timer = setInterval(() => runScheduledTick(context), intervalMs);
  }, jitter);
}

export function stopScheduler(): void {
  if (jitterTimeout) {
    clearTimeout(jitterTimeout);
    jitterTimeout = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

export async function determineSyncAction(
  context: vscode.ExtensionContext
): Promise<SyncAction> {
  const syncState = await loadSyncState(context);

  if (!syncState || !syncState.gistId) {
    return { action: "push" };
  }

  const token = await requireToken(context);
  if (!token) {
    return { action: "error", reason: "no_token" };
  }

  const client = new GistClient(token);
  const gistResult = await withRetry(() => client.getGist(syncState.gistId));
  if (!gistResult.ok) {
    return { action: "error", reason: gistResult.error.category };
  }

  const manifestFile = gistResult.data.files["manifest.json"];
  if (!manifestFile) {
    return { action: "push" };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestFile.content) as Manifest;
  } catch {
    return { action: "push" };
  }

  const remoteChecksums: Record<string, string> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    remoteChecksums[key] = entry.checksum;
  }

  const localFiles = await enumerateSyncFiles(context);
  const localChecksums: Record<string, string> = {};
  for (const file of localFiles) {
    try {
      const buf = await fs.readFile(file.absolutePath);
      localChecksums[file.relativeSyncKey] = computeChecksum(buf);
    } catch {
      continue;
    }
  }

  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
    ...Object.keys(syncState.localChecksums),
    ...Object.keys(syncState.remoteChecksums),
  ]);

  let localHasChanges = false;
  let remoteHasChanges = false;
  const conflictKeys: string[] = [];

  for (const key of allKeys) {
    const baseLocal = syncState.localChecksums[key];
    const baseRemote = syncState.remoteChecksums[key];
    const currentLocal = localChecksums[key];
    const currentRemote = remoteChecksums[key];

    const localChanged = currentLocal !== baseLocal;
    const remoteChanged = currentRemote !== baseRemote;

    if (localChanged) {
      localHasChanges = true;
    }
    if (remoteChanged) {
      remoteHasChanges = true;
    }

    if (localChanged && remoteChanged && currentLocal !== currentRemote) {
      conflictKeys.push(key);
    }
  }

  if (conflictKeys.length > 0) {
    return { action: "conflict", keys: conflictKeys };
  }

  if (remoteHasChanges && localHasChanges) {
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

export const scheduledSyncActionResolver = {
  determineSyncAction,
};

export const scheduledAppStorageSyncActionResolver = {
  determineAppStorageSyncAction,
};

export async function scheduledTick(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  if (isSyncOperationActive()) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: operation in progress`
    );
    sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" });
    return;
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Scheduled sync triggered`
  );

  let statusBarFinalizedThisTick = false;
  try {
    const appSessionActive = !!(await getAppSession(context));
    const result = appSessionActive
      ? await scheduledAppStorageSyncActionResolver.determineAppStorageSyncAction(
          context,
          { trigger: "scheduled" }
        )
      : await scheduledSyncActionResolver.determineSyncAction(context);

    switch (result.action) {
      case "none":
        if (appSessionActive) {
          await maybeFinalizeAppStorageRecovery(context, "scheduled");
        }
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: already in sync, skipping`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: "already_in_sync" });
        break;

      case "baseline_refresh": {
        const remote = await fetchAppConfigs(context, { trigger: "scheduled" });
        if (remote) {
          await applyAppStorageBaselineRefresh(
            context,
            result.keys,
            remote.updated_at
          );
        }
        if (appSessionActive) {
          await maybeFinalizeAppStorageRecovery(context, "scheduled");
        }
        break;
      }

      case "pull": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: remote changes detected, pulling`
        );
        const pullResult = await executePull(context, {
          trigger: "scheduled",
          keys: "keys" in result ? (result.keys as string[]) : undefined,
          remoteDeletions:
            "remoteDeletions" in result
              ? (result.remoteDeletions as string[])
              : undefined,
        });
        if (executePullSucceeded(pullResult)) {
          await clearScheduledRootHeldMarkers(context);
        }
        break;
      }

      case "push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local changes detected, pushing`
        );
        const pushOk = await executePush(context, {
          trigger: "scheduled",
          keys: "keys" in result ? (result.keys as string[]) : undefined,
          deletions: "deletions" in result ? (result.deletions as string[]) : undefined,
        });
        break;
      }

      case "pull-push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local and remote changes detected, pulling then pushing`
        );
        const pullResult = await executePull(context, {
          trigger: "scheduled",
          keys: "pullKeys" in result ? (result.pullKeys as string[]) : undefined,
          remoteDeletions:
            "remoteDeletions" in result
              ? (result.remoteDeletions as string[])
              : undefined,
        });
        if (pullResult.status !== "success") {
          break;
        }
        const pushOk = await executePush(context, {
          trigger: "scheduled",
          keys: "pushKeys" in result ? (result.pushKeys as string[]) : undefined,
          deletions:
            "deletions" in result ? (result.deletions as string[]) : undefined,
        });
        if (pullResult.status === "success" && pushOk) {
          await clearScheduledRootHeldMarkers(context);
        }
        break;
      }

      case "conflict": {
        const conflictMessage = `${result.keys.length} conflict(s) detected. Resolve them first.`;
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: conflicts on [${result.keys.join(", ")}]`
        );
        sendEvent(context, "scheduled_sync_skipped", {
          reason: "conflict",
          conflict_count: result.keys.length,
        });
        if (appSessionActive) {
          void notifyAppStorageConflicts(context, result.keys, {
            scheduled: true,
            trigger: "scheduled",
          });
        } else {
          void showSyncFailureWithDebug(
            context,
            buildSyncDebugFailure("scheduler", "scheduled", conflictMessage, {
              category: "CONFLICT",
              conflictCount: result.keys.length,
            }),
            { level: "warning", title: conflictMessage }
          );
        }
        break;
      }

      case "blocked": {
        const blockMessage = result.message;
        const fingerprint = `blocked:${blockMessage}`;
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync held: ${blockMessage}`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: "blocked" });
        const { addSyncHistoryEntry } = await import("./diagnostics.js");
        const prev = context.globalState.get<string>(
          "cursorSync.appStorage.scheduledRootHeldHistory"
        );
        if (prev !== fingerprint) {
          await context.globalState.update(
            "cursorSync.appStorage.scheduledRootHeldHistory",
            fingerprint
          );
          await addSyncHistoryEntry(context, {
            timestamp: new Date().toISOString(),
            direction: "pull",
            trigger: "scheduled",
            fileCount: 0,
            success: true,
            destination: "cursor-sync-storage",
            error: `held: ${blockMessage}`,
          });
        }
        break;
      }

      case "error": {
        if (result.reason === "session_expired") {
          logger.appendLine(
            `[${new Date().toISOString()}] Scheduled sync skipped: session expired`
          );
          sendEvent(context, "scheduled_sync_skipped", { reason: "session_expired" });
          await refreshSyncStatusBar(context, { failed: true });
          statusBarFinalizedThisTick = true;
          refreshSidebar();
          break;
        }
        const errorMessage = `Scheduled sync failed: ${result.reason}`;
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: ${result.reason}`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: result.reason });
        void showSyncFailureWithDebug(
          context,
          buildSyncDebugFailure("scheduler", "scheduled", result.reason, {
            category: result.reason,
          }),
          { title: errorMessage }
        );
        await refreshSyncStatusBar(context, { failed: true });
        statusBarFinalizedThisTick = true;
        refreshSidebar();
        break;
      }
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync failed: ${errMessage}`
    );
    sendEvent(context, "scheduled_sync_failed", { reason: "exception" });
    const { isAppConfigsFetchError } = await import("./app-config-fetch-errors.js");
    if (!isAppConfigsFetchError(err)?.historyRecorded) {
      const errorMessage = `Scheduled sync failed: ${errMessage}`;
      void showSyncFailureWithDebug(
        context,
        buildSyncDebugFailure("scheduler", "scheduled", errMessage),
        { title: errorMessage }
      );
    }
    await refreshSyncStatusBar(context, { failed: true });
    refreshSidebar();
    return;
  }
  if (!statusBarFinalizedThisTick) {
    await refreshSyncStatusBar(context);
    refreshSidebar();
  }
}
