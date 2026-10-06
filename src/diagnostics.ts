import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncState, SyncHistoryEntry } from "./types.js";
import { syncDestinationLabel } from "./sync-destination.js";
import type { SyncDestinationId } from "./sync-destination.js";

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

function formatHistoryAttemptDescription(entry: SyncHistoryEntry): string {
  const when = formatStatusTimestamp(entry.timestamp);
  if (entry.success) {
    const summary = entry.error ? ` — ${entry.error}` : "";
    return `${when} — succeeded (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})${summary}`;
  }
  return `${when} — failed${entry.error ? `: ${entry.error}` : ""}`;
}

export function buildStatusQuickPickItems(
  syncState: SyncState | undefined,
  history: SyncHistoryEntry[]
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
  const items = buildStatusQuickPickItems(syncState, history);
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
