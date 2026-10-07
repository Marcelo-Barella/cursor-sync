import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncState, SyncHistoryEntry } from "./types.js";
import { syncDestinationLabel } from "./sync-destination.js";
import type { SyncDestinationId } from "./sync-destination.js";
import {
  deriveStorageSyncPresentation,
  formatStorageHistoryQuickPickLine,
  latestStorageHistoryEntry,
  storageSyncSidebarStatusDetail,
} from "./storage-sync-ui-status.js";

const MAX_HISTORY_ENTRIES = 50;

let outputChannel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Cursor Sync");
  }
  return outputChannel;
}

function latestHistoryAttempt(
  history: SyncHistoryEntry[],
  destination: SyncDestinationId
): SyncHistoryEntry | undefined {
  return history.find(
    (entry) => (entry.destination ?? "github-gist") === destination
  );
}

export function formatStatusTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString();
}

function formatAppStorageStatusDescription(
  history: SyncHistoryEntry[],
  activeHeldFingerprint?: string
): string {
  const presentation = deriveStorageSyncPresentation({
    history,
    activeHeldFingerprint,
  });
  const entry = latestStorageHistoryEntry(history);
  return storageSyncSidebarStatusDetail(presentation, entry);
}

function formatHistoryAttemptDescription(entry: SyncHistoryEntry): string {
  if (entry.destination === "cursor-sync-storage") {
    return formatStorageHistoryQuickPickLine(entry);
  }
  const when = formatStatusTimestamp(entry.timestamp);
  if (entry.success) {
    const summary = entry.error ? ` — ${entry.error}` : "";
    return `${when} — succeeded (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})${summary}`;
  }
  return `${when} — failed${entry.error ? `: ${entry.error}` : ""}`;
}

export function buildStatusQuickPickItems(
  syncState: SyncState | undefined,
  history: SyncHistoryEntry[],
  options?: { activeHeldFingerprint?: string }
): vscode.QuickPickItem[] {
  const items: vscode.QuickPickItem[] = [];

  const gistAttempt = latestHistoryAttempt(history, "github-gist");
  const appAttempt = latestHistoryAttempt(history, "cursor-sync-storage");

  if (!syncState && !gistAttempt && !appAttempt) {
    items.push({ label: "Status", description: "No sync performed yet" });
    return items;
  }

  if (syncState) {
    items.push({
      label: "GitHub Gist — last sync",
      description: formatStatusTimestamp(syncState.lastSyncTimestamp),
    });
    items.push({
      label: "GitHub Gist — direction",
      description: syncState.lastSyncDirection,
    });
    items.push({
      label: "GitHub Gist — gist ID",
      description: syncState.gistId,
    });
    items.push({
      label: "GitHub Gist — URL",
      description: `https://gist.github.com/${syncState.gistId}`,
    });
    items.push({
      label: "GitHub Gist — files tracked",
      description: String(Object.keys(syncState.localChecksums).length),
    });
  } else if (gistAttempt) {
    items.push({
      label: `GitHub Gist — last ${gistAttempt.direction}`,
      description: formatHistoryAttemptDescription(gistAttempt),
    });
    items.push({
      label: "GitHub Gist — destination",
      description: syncDestinationLabel("github-gist"),
    });
  }

  if (appAttempt) {
    const storageDetail = formatAppStorageStatusDescription(
      history,
      options?.activeHeldFingerprint
    );
    items.push({
      label: "Cursor Sync storage — status",
      description: storageDetail,
    });
    items.push({
      label: `Cursor Sync storage — last ${appAttempt.direction}`,
      description: formatHistoryAttemptDescription(appAttempt),
    });
    items.push({
      label: "Cursor Sync storage — destination",
      description: syncDestinationLabel("cursor-sync-storage"),
    });
  }

  return items;
}

export async function showStatus(
  context: vscode.ExtensionContext
): Promise<void> {
  const syncState = await loadSyncState(context);
  const history = await loadSyncHistory(context);
  const { activeScheduledRootHeldFingerprint } = await import(
    "./storage-sync-ui-status.js"
  );
  const items = buildStatusQuickPickItems(syncState, history, {
    activeHeldFingerprint: activeScheduledRootHeldFingerprint(context),
  });
  vscode.window.showQuickPick(items, { title: "Cursor Sync Status" });
}

export function getSyncStatePath(context: vscode.ExtensionContext): string {
  return path.join(
    context.globalStorageUri.fsPath,
    "sync-state.json"
  );
}

export async function loadSyncState(
  context: vscode.ExtensionContext
): Promise<SyncState | undefined> {
  const filePath = getSyncStatePath(context);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as SyncState;
  } catch {
    return undefined;
  }
}

export async function saveSyncState(
  context: vscode.ExtensionContext,
  state: SyncState
): Promise<void> {
  const filePath = getSyncStatePath(context);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function clearSyncState(
  context: vscode.ExtensionContext
): Promise<void> {
  const filePath = getSyncStatePath(context);
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

function getSyncHistoryPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "sync-history.json");
}

export async function loadSyncHistory(
  context: vscode.ExtensionContext
): Promise<SyncHistoryEntry[]> {
  const filePath = getSyncHistoryPath(context);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as SyncHistoryEntry[];
  } catch {
    return [];
  }
}

const STORAGE_RECOVERY_HISTORY_MESSAGE = "Recovered — already in sync";

export async function recordStorageSyncRecovery(
  context: vscode.ExtensionContext,
  trigger: SyncHistoryEntry["trigger"]
): Promise<void> {
  const history = await loadSyncHistory(context);
  const latestStorage = history.find(
    (entry) => entry.destination === "cursor-sync-storage"
  );
  if (latestStorage?.error === STORAGE_RECOVERY_HISTORY_MESSAGE) {
    return;
  }
  await addSyncHistoryEntry(context, {
    timestamp: new Date().toISOString(),
    direction: "pull",
    trigger,
    fileCount: 0,
    success: true,
    destination: "cursor-sync-storage",
    error: STORAGE_RECOVERY_HISTORY_MESSAGE,
  });
}

export async function maybeFinalizeAppStorageRecovery(
  context: vscode.ExtensionContext,
  trigger: SyncHistoryEntry["trigger"]
): Promise<void> {
  const { activeScheduledRootHeldFingerprint } = await import(
    "./storage-sync-ui-status.js"
  );
  const heldFp = activeScheduledRootHeldFingerprint(context);
  const history = await loadSyncHistory(context);
  const latest = latestStorageHistoryEntry(history);
  const wasDegraded =
    Boolean(heldFp) ||
    Boolean(latest?.held) ||
    Boolean(latest?.error?.startsWith("held:")) ||
    Boolean(latest?.partial) ||
    Boolean(
      latest &&
        !latest.success &&
        !latest.held &&
        !latest.partial &&
        !latest.conflict
    );

  if (!wasDegraded) {
    return;
  }

  const { clearScheduledRootHeldMarkers } = await import("./app-configs.js");
  await clearScheduledRootHeldMarkers(context);
  await recordStorageSyncRecovery(context, trigger);
}

export async function addSyncHistoryEntry(
  context: vscode.ExtensionContext,
  entry: SyncHistoryEntry
): Promise<void> {
  const history = await loadSyncHistory(context);
  history.unshift(entry);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.length = MAX_HISTORY_ENTRIES;
  }
  const filePath = getSyncHistoryPath(context);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(history, null, 2), "utf-8");
}
