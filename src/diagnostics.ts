import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SyncState } from "./types.js";

let outputChannel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Cursor Sync");
  }
  return outputChannel;
}

export async function showStatus(
  context: vscode.ExtensionContext
): Promise<void> {
  const syncState = await loadSyncState(context);
  const items: vscode.QuickPickItem[] = [];

  if (!syncState) {
    items.push({ label: "Status", description: "No sync performed yet" });
    vscode.window.showQuickPick(items, { title: "Cursor Sync Status" });
    return;
  }

  items.push({
    label: "Last Sync",
    description: syncState.lastSyncTimestamp,
  });
  items.push({
    label: "Direction",
    description: syncState.lastSyncDirection,
  });
  items.push({
    label: "Gist ID",
    description: syncState.gistId,
  });
  items.push({
    label: "Gist URL",
    description: `https://gist.github.com/${syncState.gistId}`,
  });
  items.push({
    label: "Files Synced",
    description: String(Object.keys(syncState.localChecksums).length),
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
