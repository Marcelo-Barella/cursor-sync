import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { executePush, isPushLocked } from "./push.js";
import { executePull, isPullLocked } from "./pull.js";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { loadSyncState, getLogger } from "./diagnostics.js";
import { enumerateSyncFiles } from "./paths.js";
import { computeChecksum } from "./packaging.js";
import { sendEvent } from "./analytics.js";
import type { Manifest } from "./types.js";

const MIN_INTERVAL_MINUTES = 5;
const MAX_JITTER_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let jitterTimeout: ReturnType<typeof setTimeout> | undefined;

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
    scheduledTick(context);
    timer = setInterval(() => scheduledTick(context), intervalMs);
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

  const localFiles = await enumerateSyncFiles();
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

async function scheduledTick(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();

  if (isPushLocked() || isPullLocked()) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: operation in progress`
    );
    sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" });
    return;
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Scheduled sync triggered`
  );

  try {
    const result = await determineSyncAction(context);

    switch (result.action) {
      case "none":
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: already in sync, skipping`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: "already_in_sync" });
        break;

      case "pull": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: remote changes detected, pulling`
        );
        await executePull(context, { trigger: "scheduled" });
        break;
      }

      case "push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local changes detected, pushing`
        );
        await executePush(context, { trigger: "scheduled" });
        break;
      }

      case "pull-push": {
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync: local and remote changes detected, pulling then pushing`
        );
        const pullOk = await executePull(context, { trigger: "scheduled" });
        if (pullOk) {
          await executePush(context, { trigger: "scheduled" });
        }
        break;
      }

      case "conflict":
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: conflicts on [${result.keys.join(", ")}]`
        );
        sendEvent(context, "scheduled_sync_skipped", {
          reason: "conflict",
          conflict_count: result.keys.length,
        });
        break;

      case "error":
        logger.appendLine(
          `[${new Date().toISOString()}] Scheduled sync skipped: ${result.reason}`
        );
        sendEvent(context, "scheduled_sync_skipped", { reason: result.reason });
        break;
    }
  } catch (err) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync failed: ${err instanceof Error ? err.message : String(err)}`
    );
    sendEvent(context, "scheduled_sync_failed", { reason: "exception" });
  }
}
