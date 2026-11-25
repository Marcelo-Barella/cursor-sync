import type * as vscode from "vscode";
import type { SyncHistoryEntry } from "./types.js";
import { formatStatusTimestamp } from "./diagnostics.js";

export const SCHEDULED_ROOT_HELD_HISTORY_KEY =
  "cursorSync.appStorage.scheduledRootHeldHistory";

export type StorageSyncUiLevel = "error" | "warning" | "ok" | "conflict";

export interface StorageSyncUiPresentation {
  level: StorageSyncUiLevel;
  detail: string;
  lastSync?: Date;
  warningKind?: "held" | "partial";
}

export function activeScheduledRootHeldFingerprint(
  context: vscode.ExtensionContext
): string | undefined {
  return context.globalState.get<string>(SCHEDULED_ROOT_HELD_HISTORY_KEY);
}

export function latestStorageHistoryEntry(
  history: SyncHistoryEntry[]
): SyncHistoryEntry | undefined {
  return history.find((entry) => entry.destination === "cursor-sync-storage");
}

function entryDetail(entry: SyncHistoryEntry): string {
  const when = formatStatusTimestamp(entry.timestamp);
  if (entry.held || entry.error?.startsWith("held:")) {
    const msg = entry.error?.replace(/^held:\s*/, "") ?? "sync held";
    return `pull held at ${when}: ${msg}`;
  }
  if (entry.conflict) {
    return `conflict at ${when} (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})`;
  }
  if (entry.partial) {
    return `${entry.direction} partial at ${when} (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})`;
  }
  if (entry.success) {
    return `${entry.direction} succeeded at ${when} (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})`;
  }
  return `${entry.direction} failed at ${when}${entry.error ? `: ${entry.error}` : ""}`;
}

function sidebarStatusLabel(entry: SyncHistoryEntry): string {
  if (entry.held || entry.error?.startsWith("held:")) {
    return `Storage pull held`;
  }
  if (entry.partial) {
    return `Storage ${entry.direction} partial`;
  }
  if (entry.success) {
    return `Storage ${entry.direction} succeeded`;
  }
  return `Storage ${entry.direction} failed`;
}

export function deriveStorageSyncPresentation(input: {
  history: SyncHistoryEntry[];
  activeHeldFingerprint?: string;
  tickFailed?: boolean;
}): StorageSyncUiPresentation {
  const activeHeld = Boolean(input.activeHeldFingerprint);
  const storageHistory = input.history.filter(
    (e) => e.destination === "cursor-sync-storage"
  );
  const latestAny = storageHistory[0];
  const latestEffective =
    !activeHeld && latestAny?.held
      ? storageHistory.find((e) => !e.held && !e.error?.startsWith("held:"))
      : latestAny;

  const entry = latestEffective ?? latestAny;

  if (input.tickFailed) {
    return {
      level: "error",
      detail: entry ? entryDetail(entry) : "Sync failed",
      lastSync: entry ? new Date(entry.timestamp) : undefined,
    };
  }

  if (entry?.conflict) {
    return {
      level: "conflict",
      detail: entryDetail(entry),
      lastSync: new Date(entry.timestamp),
    };
  }

  const entryIsFailure =
    entry &&
    !entry.success &&
    !entry.partial &&
    !entry.held &&
    !entry.error?.startsWith("held:");
  if (entryIsFailure) {
    return {
      level: "error",
      detail: entryDetail(entry),
      lastSync: new Date(entry.timestamp),
    };
  }

  if (activeHeld || entry?.held || entry?.error?.startsWith("held:")) {
    const heldEntry =
      storageHistory.find((e) => e.held || e.error?.startsWith("held:")) ?? entry;
    return {
      level: "warning",
      warningKind: "held",
      detail: heldEntry ? entryDetail(heldEntry) : "Sync held",
      lastSync: heldEntry ? new Date(heldEntry.timestamp) : undefined,
    };
  }

  if (entry?.partial) {
    return {
      level: "warning",
      warningKind: "partial",
      detail: entryDetail(entry),
      lastSync: new Date(entry.timestamp),
    };
  }

  if (entry) {
    return {
      level: "ok",
      detail: entryDetail(entry),
      lastSync: new Date(entry.timestamp),
    };
  }

  return { level: "ok", detail: "Logged in — no storage sync yet" };
}

export function storageSyncSidebarStatus(
  presentation: StorageSyncUiPresentation
): "synced" | "error" | "syncing" | "warning" {
  if (presentation.level === "error") {
    return "error";
  }
  if (presentation.level === "warning") {
    return "warning";
  }
  return "synced";
}

export function storageSyncSidebarStatusDetail(
  presentation: StorageSyncUiPresentation,
  entry?: SyncHistoryEntry
): string {
  if (entry) {
    if (presentation.warningKind === "held") {
      return sidebarStatusLabel({ ...entry, held: true, success: false });
    }
    if (presentation.warningKind === "partial" || entry.partial) {
      return sidebarStatusLabel({ ...entry, partial: true, success: true });
    }
    if (presentation.level === "error") {
      return sidebarStatusLabel({ ...entry, success: false });
    }
    return sidebarStatusLabel({ ...entry, success: true });
  }
  return presentation.detail;
}

export function formatAppStorageLastDirectionDescription(
  entry: SyncHistoryEntry,
  history: SyncHistoryEntry[],
  activeHeldFingerprint?: string
): string {
  const presentation = deriveStorageSyncPresentation({
    history,
    activeHeldFingerprint,
  });
  const when = formatStatusTimestamp(entry.timestamp);
  const dir = entry.direction;

  if (presentation.warningKind === "held" || entry.held || entry.error?.startsWith("held:")) {
    const heldMsg =
      entry.error?.replace(/^held:\s*/, "") ??
      presentation.detail.replace(/^pull held at [^:]+: /, "");
    return `${when} — last ${dir}: held — ${heldMsg}`;
  }
  if (presentation.warningKind === "partial" || entry.partial) {
    return `${when} — last ${dir}: partial — ${presentation.detail}`;
  }
  if (presentation.level === "error" || presentation.level === "conflict") {
    return `${when} — last ${dir}: failed — ${presentation.detail}`;
  }
  const summary = entry.error ? ` — ${entry.error}` : "";
  return `${when} — last ${dir}: succeeded (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})${summary}`;
}

export function formatStorageHistoryQuickPickLine(entry: SyncHistoryEntry): string {
  const when = formatStatusTimestamp(entry.timestamp);
  if (entry.held || entry.error?.startsWith("held:")) {
    return `${when} — held (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})`;
  }
  if (entry.partial) {
    return `${when} — partial (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})${entry.error ? ` — ${entry.error}` : ""}`;
  }
  if (entry.success) {
    const summary = entry.error ? ` — ${entry.error}` : "";
    return `${when} — succeeded (${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"})${summary}`;
  }
  return `${when} — failed${entry.error ? `: ${entry.error}` : ""}`;
}
