import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import type {
  SyncState,
  ConflictEntry,
  ResolvedConflict,
  ConflictResolution,
} from "./types.js";
import { computeChecksum } from "./packaging.js";
import { enumerateSyncFiles } from "./paths.js";
import { loadSyncState } from "./diagnostics.js";
import { getLogger } from "./diagnostics.js";

let pendingResolutions: ResolvedConflict[] = [];
let pendingConflicts: ConflictEntry[] = [];

export function getPendingConflicts(): ConflictEntry[] {
  return pendingConflicts;
}

export function getPendingResolutions(): ResolvedConflict[] {
  return pendingResolutions;
}

export function clearConflicts(): void {
  pendingConflicts = [];
  pendingResolutions = [];
  vscode.commands.executeCommand("setContext", "cursorSync.hasConflicts", false);
}

export async function detectConflicts(
  context: vscode.ExtensionContext,
  remoteChecksums: Record<string, string>
): Promise<ConflictEntry[]> {
  const syncState = await loadSyncState(context);
  if (!syncState) {
    return [];
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

  const conflicts: ConflictEntry[] = [];
  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
  ]);

  for (const key of allKeys) {
    const baseLocal = syncState.localChecksums[key];
    const baseRemote = syncState.remoteChecksums[key];
    const currentLocal = localChecksums[key];
    const currentRemote = remoteChecksums[key];

    if (!baseLocal || !baseRemote) {
      continue;
    }

    const localChanged = currentLocal !== baseLocal;
    const remoteChanged = currentRemote !== baseRemote;

    if (localChanged && remoteChanged && currentLocal !== currentRemote) {
      conflicts.push({
        relativeSyncKey: key,
        localChecksum: currentLocal ?? "",
        remoteChecksum: currentRemote ?? "",
        baseChecksum: baseLocal,
      });
    }
  }

  if (conflicts.length > 0) {
    pendingConflicts = conflicts;
    await vscode.commands.executeCommand(
      "setContext",
      "cursorSync.hasConflicts",
      true
    );
  }

  return conflicts;
}

export async function resolveConflictsCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  if (pendingConflicts.length === 0) {
    vscode.window.showInformationMessage("No conflicts to resolve.");
    return;
  }

  const resolutions: ResolvedConflict[] = [];

  for (const conflict of pendingConflicts) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Keep Local", value: "keepLocal" as ConflictResolution },
        { label: "Keep Remote", value: "keepRemote" as ConflictResolution },
        { label: "Skip (decide later)", value: "skip" as ConflictResolution },
      ],
      {
        title: `Conflict: ${conflict.relativeSyncKey}`,
        placeHolder: "Choose which version to keep",
      }
    );

    if (!choice) {
      return;
    }

    resolutions.push({
      relativeSyncKey: conflict.relativeSyncKey,
      resolution: choice.value,
    });
  }

  pendingResolutions = resolutions;

  const hasSkipped = resolutions.some((r) => r.resolution === "skip");
  if (!hasSkipped) {
    pendingConflicts = [];
    await vscode.commands.executeCommand(
      "setContext",
      "cursorSync.hasConflicts",
      false
    );
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Conflicts resolved: ${resolutions.length} decisions`
  );
  vscode.window.showInformationMessage(
    `Resolved ${resolutions.length} conflict(s). You can now push or pull.`
  );
}

export function getResolutionForKey(
  key: string
): ConflictResolution | undefined {
  const entry = pendingResolutions.find((r) => r.relativeSyncKey === key);
  return entry?.resolution;
}
