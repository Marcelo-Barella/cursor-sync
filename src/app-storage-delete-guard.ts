import type * as vscode from "vscode";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";
import { syncKeyRootPrefix } from "./app-config-sync-root-keys.js";
import { USER_LABEL_DOT_CURSOR } from "./paths.js";

export type DeleteGuardTrigger = "manual" | "scheduled" | "syncNow" | "startup";

export interface MassDeleteDecision {
  proceed: boolean;
  needsModalConfirm: boolean;
  schedulerBlocked: boolean;
  reason?: string;
}

export const MASS_DELETE_MAX_WITHOUT_CONFIRM = 3;
export const MASS_DELETE_FRACTION_WITHOUT_CONFIRM = 0.5;

let lastSchedulerMassDeleteBlockSignature: string | undefined;
let lastMassDeleteBlockedDeletionKey: string | undefined;
let lastEvaluatedMassDeleteBlockDeletions: string[] = [];

export function setLastEvaluatedMassDeleteBlockDeletions(deletions: string[]): void {
  lastEvaluatedMassDeleteBlockDeletions = [...deletions];
}

export function getLastEvaluatedMassDeleteBlockDeletions(): string[] {
  return lastEvaluatedMassDeleteBlockDeletions;
}

export function resetSchedulerMassDeleteBlockDedupe(): void {
  lastSchedulerMassDeleteBlockSignature = undefined;
}

function blockedDeletionSetKey(deletions: string[]): string {
  return [...deletions].sort().join("\0");
}

export function noteMassDeleteBlockedDeletions(deletions: string[]): void {
  const key = blockedDeletionSetKey(deletions);
  if (lastMassDeleteBlockedDeletionKey !== key) {
    resetSchedulerMassDeleteBlockDedupe();
    lastMassDeleteBlockedDeletionKey = key;
  }
}

export function clearMassDeleteBlockedDeletionKey(): void {
  lastMassDeleteBlockedDeletionKey = undefined;
}

export function massDeleteBlockSignature(
  direction: "push" | "pull",
  deletions: string[],
  reason: string
): string {
  return `${direction}:${reason}:${[...deletions].sort().join("\0")}`;
}

export function shouldRecordSchedulerMassDeleteBlock(
  signature: string
): boolean {
  if (signature === lastSchedulerMassDeleteBlockSignature) {
    return false;
  }
  lastSchedulerMassDeleteBlockSignature = signature;
  return true;
}

export function clearSchedulerMassDeleteBlockIfResolved(
  deletions: string[]
): void {
  if (deletions.length === 0) {
    lastSchedulerMassDeleteBlockSignature = undefined;
    lastMassDeleteBlockedDeletionKey = undefined;
    return;
  }
  const key = blockedDeletionSetKey(deletions);
  if (
    lastMassDeleteBlockedDeletionKey !== undefined &&
    key !== lastMassDeleteBlockedDeletionKey
  ) {
    resetSchedulerMassDeleteBlockDedupe();
    lastMassDeleteBlockedDeletionKey = key;
  }
}

export function exceedsMassDeleteThreshold(
  deletionCount: number,
  trackedKeyCount: number
): boolean {
  if (deletionCount === 0) {
    return false;
  }
  if (trackedKeyCount > 0 && deletionCount >= trackedKeyCount) {
    return true;
  }
  if (deletionCount > MASS_DELETE_MAX_WITHOUT_CONFIRM) {
    return true;
  }
  if (
    trackedKeyCount > 0 &&
    deletionCount >= trackedKeyCount * MASS_DELETE_FRACTION_WITHOUT_CONFIRM
  ) {
    return true;
  }
  return false;
}

const ROOT_HELD_LABELS: Record<string, string> = {
  "dot-cursor/": USER_LABEL_DOT_CURSOR,
  "cursor-user/": "Cursor User settings",
};

export function listPerFileHeldSyncKeys(
  scan: LocalConfigFileScan,
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>
): string[] {
  const held: string[] = [];
  for (const key of scan.skippedUnknownKeys) {
    const remote = remoteChecksums[key];
    const local = localChecksums[key];
    if (remote !== undefined && local !== remote) {
      held.push(key);
      continue;
    }
    if (remote !== undefined && local === undefined) {
      held.push(key);
      continue;
    }
    if (local !== undefined && remote === undefined) {
      held.push(key);
    }
  }
  for (const key of scan.unreadableKeys) {
    if (held.includes(key)) {
      continue;
    }
    const remote = remoteChecksums[key];
    const local = localChecksums[key];
    if (remote !== undefined && local !== remote) {
      held.push(key);
    } else if (remote !== undefined && local === undefined) {
      held.push(key);
    }
  }
  return held.sort();
}

export type PerFileHeldReason =
  | "unreadable"
  | "excluded"
  | "oversize"
  | "symlink"
  | "under_symlinked_dir"
  | "unsafe_path"
  | "changed_during_write"
  | "root_unavailable";

function scanSet(scan: LocalConfigFileScan, key: keyof LocalConfigFileScan): Set<string> {
  const value = scan[key];
  return value instanceof Set ? value : new Set();
}

export type PullSkipReasonOverrides = ReadonlyMap<string, PerFileHeldReason>;

export function perFileHeldReasonForKey(
  syncKey: string,
  scan: LocalConfigFileScan,
  overrides?: PullSkipReasonOverrides
): PerFileHeldReason {
  const override = overrides?.get(syncKey);
  if (override) {
    return override;
  }
  if (scanSet(scan, "excludedKeys").has(syncKey)) {
    return "excluded";
  }
  if (scanSet(scan, "oversizeKeys").has(syncKey)) {
    return "oversize";
  }
  if (scanSet(scan, "symlinkKeys").has(syncKey)) {
    return "symlink";
  }
  if (scanSet(scan, "underSymlinkedDirKeys").has(syncKey)) {
    return "under_symlinked_dir";
  }
  const prefix = syncKeyRootPrefix(syncKey);
  if (prefix && scan.deleteBlockedRootPrefixes.has(prefix)) {
    return "root_unavailable";
  }
  if (
    scan.skippedUnknownKeys.has(syncKey) &&
    !scanSet(scan, "excludedKeys").has(syncKey) &&
    !scanSet(scan, "oversizeKeys").has(syncKey) &&
    !scanSet(scan, "symlinkKeys").has(syncKey) &&
    !scanSet(scan, "underSymlinkedDirKeys").has(syncKey)
  ) {
    return "unreadable";
  }
  return "unsafe_path";
}

function formatHeldGroup(label: string, keys: string[]): string {
  const preview = keys.slice(0, 2).join(", ");
  const suffix = keys.length > 2 ? ` (+${keys.length - 2} more)` : "";
  return `${keys.length} ${label} (${preview}${suffix})`;
}

export function formatPerFileSyncHeldNotice(
  scan: LocalConfigFileScan,
  heldKeys: string[],
  overrides?: PullSkipReasonOverrides
): string {
  const unreadable: string[] = [];
  const excluded: string[] = [];
  const oversize: string[] = [];
  const symlink: string[] = [];
  const underSymlinkDir: string[] = [];
  const changedDuringWrite: string[] = [];
  const rootUnavailable: string[] = [];
  const unsafe: string[] = [];
  for (const key of heldKeys) {
    const reason = perFileHeldReasonForKey(key, scan, overrides);
    if (reason === "excluded") {
      excluded.push(key);
    } else if (reason === "oversize") {
      oversize.push(key);
    } else if (reason === "symlink") {
      symlink.push(key);
    } else if (reason === "under_symlinked_dir") {
      underSymlinkDir.push(key);
    } else if (reason === "unreadable") {
      unreadable.push(key);
    } else if (reason === "changed_during_write") {
      changedDuringWrite.push(key);
    } else if (reason === "root_unavailable") {
      rootUnavailable.push(key);
    } else {
      unsafe.push(key);
    }
  }
  const parts: string[] = [];
  if (unreadable.length > 0) {
    parts.push(formatHeldGroup("unreadable", unreadable));
  }
  if (excluded.length > 0) {
    parts.push(formatHeldGroup("excluded", excluded));
  }
  if (oversize.length > 0) {
    parts.push(formatHeldGroup("oversize", oversize));
  }
  if (symlink.length > 0) {
    parts.push(formatHeldGroup("symlink", symlink));
  }
  if (underSymlinkDir.length > 0) {
    const labels = scan.symlinkedFolderLabels ?? {};
    const byDir = new Map<string, string[]>();
    for (const key of underSymlinkDir) {
      const dir = labels[key] ?? key;
      const list = byDir.get(dir) ?? [];
      list.push(key);
      byDir.set(dir, list);
    }
    for (const [dir, keys] of byDir) {
      const preview = keys.slice(0, 2).join(", ");
      const suffix = keys.length > 2 ? ` (+${keys.length - 2} more)` : "";
      parts.push(
        `${keys.length} inside symlinked folder ${dir} (${preview}${suffix})`
      );
    }
  }
  if (changedDuringWrite.length > 0) {
    parts.push(formatHeldGroup("changed during write", changedDuringWrite));
  }
  if (rootUnavailable.length > 0) {
    parts.push(formatHeldGroup("sync root unavailable", rootUnavailable));
  }
  if (unsafe.length > 0) {
    parts.push(formatHeldGroup("unsafe path", unsafe));
  }
  if (parts.length === 0) {
    const preview = heldKeys.slice(0, 3).join(", ");
    const suffix = heldKeys.length > 3 ? ` (+${heldKeys.length - 3} more)` : "";
    return `Sync held: ${heldKeys.length} file(s): ${preview}${suffix}`;
  }
  return `Sync held: ${parts.join("; ")}`;
}

export function formatPullHeldRemoteUpdateNotice(
  scan: LocalConfigFileScan,
  heldKeys: string[],
  overrides?: PullSkipReasonOverrides
): string {
  if (heldKeys.length === 1) {
    const key = heldKeys[0]!;
    const reason = perFileHeldReasonForKey(key, scan, overrides);
    const folder = scan.symlinkedFolderLabels?.[key];
    const label =
      reason === "symlink"
        ? "is a symlink"
        : reason === "under_symlinked_dir"
          ? `is inside symlinked folder ${folder ?? "unknown"}`
          : reason === "unreadable"
            ? "is unreadable"
            : reason === "excluded"
              ? "is excluded"
              : reason === "oversize"
                ? "is oversize"
                : reason === "changed_during_write"
                  ? "changed during write"
                  : reason === "root_unavailable"
                    ? "sync root is unavailable"
                    : "cannot be overwritten safely";
    return `1 remote update not applied: ${key} ${label}.`;
  }
  return `${heldKeys.length} remote updates not applied (${formatPerFileSyncHeldNotice(scan, heldKeys).replace(/^Sync held: /, "")}).`;
}

export function formatPullSkippedFilesNotice(
  scan: LocalConfigFileScan,
  skippedKeys: string[],
  overrides?: PullSkipReasonOverrides
): string {
  if (skippedKeys.length === 0) {
    return "";
  }
  if (skippedKeys.length === 1) {
    const key = skippedKeys[0]!;
    const reason = perFileHeldReasonForKey(key, scan, overrides);
    const folder = scan.symlinkedFolderLabels?.[key];
    const label =
      reason === "symlink"
        ? "symlink"
        : reason === "under_symlinked_dir"
          ? `inside symlinked folder ${folder ?? "unknown"}`
          : reason === "excluded"
            ? "excluded"
            : reason === "oversize"
              ? "oversize"
              : reason === "unreadable"
                ? "unreadable"
                : reason === "changed_during_write"
                  ? "changed during write"
                  : reason === "root_unavailable"
                    ? "sync root unavailable"
                    : "unsafe path";
    return `Pull skipped 1 file (${label}): ${key}`;
  }
  const detail = formatPerFileSyncHeldNotice(scan, skippedKeys, overrides).replace(
    /^Sync held: /,
    ""
  );
  return `Pull skipped ${skippedKeys.length} file(s): ${detail}`;
}

export function formatSyncRootDeleteHeldNotice(scan: LocalConfigFileScan): string {
  const prefixes = [...scan.deleteBlockedRootPrefixes];
  if (prefixes.length === 0 && !scan.deletesAllowed && scan.deleteBlockReason) {
    return `Sync held: ${scan.deleteBlockReason}`;
  }
  const rootNames = prefixes.map((p) => ROOT_HELD_LABELS[p] ?? p).join(" and ");
  let heldCount = 0;
  for (const key of scan.skippedUnknownKeys) {
    const prefix = syncKeyRootPrefix(key);
    if (prefix && prefixes.includes(prefix)) {
      heldCount += 1;
    }
  }
  if (heldCount === 0) {
    heldCount = scan.skippedUnknownKeys.size;
  }
  return `Sync held: ${rootNames} is missing or empty (${heldCount} tracked file(s) skipped). Restore the folder before pull/push deletes.`;
}

export function filterDeletionsRespectingRootBlocks(
  deletions: string[],
  scan: LocalConfigFileScan
): string[] {
  const blocked = scan.deleteBlockedRootPrefixes;
  if (!blocked || blocked.size === 0) {
    return deletions;
  }
  return deletions.filter((key) => {
    const prefix = syncKeyRootPrefix(key);
    return !prefix || !blocked.has(prefix);
  });
}

export function evaluateRemoteDeleteBatch(
  deletions: string[],
  trackedKeyCount: number,
  trigger: DeleteGuardTrigger,
  scan: LocalConfigFileScan
): MassDeleteDecision {
  const filtered = filterDeletionsRespectingRootBlocks(deletions, scan);
  if (filtered.length === 0) {
    return { proceed: true, needsModalConfirm: false, schedulerBlocked: false };
  }

  if (!scan.deletesAllowed) {
    const reason = scan.deleteBlockReason ?? "Local scan is not trustworthy for deletes";
    return {
      proceed: false,
      needsModalConfirm: false,
      schedulerBlocked: trigger === "scheduled",
      reason,
    };
  }

  if (!exceedsMassDeleteThreshold(filtered.length, trackedKeyCount)) {
    return { proceed: true, needsModalConfirm: false, schedulerBlocked: false };
  }

  const reason = `Refusing to delete ${filtered.length} of ${trackedKeyCount} tracked files without confirmation`;
  if (trigger === "scheduled") {
    return {
      proceed: false,
      needsModalConfirm: false,
      schedulerBlocked: true,
      reason,
    };
  }
  return {
    proceed: false,
    needsModalConfirm: true,
    schedulerBlocked: false,
    reason,
  };
}

export async function resolveMassDeleteBatch(
  deletions: string[],
  trackedKeyCount: number,
  trigger: DeleteGuardTrigger,
  scan: LocalConfigFileScan,
  options: {
    direction: "push" | "pull";
    modalConfirm: (reason: string) => Promise<boolean>;
  }
): Promise<string[]> {
  const filtered = filterDeletionsRespectingRootBlocks(deletions, scan);
  if (filtered.length === 0) {
    return [];
  }

  const decision = evaluateRemoteDeleteBatch(
    filtered,
    trackedKeyCount,
    trigger,
    scan
  );

  if (decision.proceed) {
    return [...filtered];
  }

  if (decision.schedulerBlocked) {
    return [];
  }

  if (decision.needsModalConfirm) {
    const ok = await options.modalConfirm(
      decision.reason ??
        `Delete ${deletions.length} ${options.direction === "push" ? "remote" : "local"} file(s)?`
    );
    return ok ? [...filtered] : [];
  }

  return [];
}

export function syncEvaluatedMassDeleteBlockState(
  candidateDeletions: string[],
  trackedKeyCount: number,
  scan: LocalConfigFileScan
): void {
  const filtered = filterDeletionsRespectingRootBlocks(candidateDeletions, scan);
  const decision = evaluateRemoteDeleteBatch(
    filtered,
    trackedKeyCount,
    "scheduled",
    scan
  );
  if (decision.schedulerBlocked && filtered.length > 0) {
    setLastEvaluatedMassDeleteBlockDeletions(filtered);
  } else {
    setLastEvaluatedMassDeleteBlockDeletions([]);
    clearMassDeleteBlockedDeletionKey();
    clearSchedulerMassDeleteBlockIfResolved([]);
  }
}

export function evaluateEmptyRemoteManifestLocalDeletes(
  remoteKeyCount: number,
  baseline: import("./app-storage-baseline.js").AppStorageBaseline | undefined,
  localDeleteCandidates: string[]
): { blocked: boolean; reason?: string } {
  if (remoteKeyCount > 0 || localDeleteCandidates.length === 0) {
    return { blocked: false };
  }
  const tracked =
    baseline && Object.keys(baseline.localChecksums).length > 0;
  if (!tracked) {
    return { blocked: false };
  }
  return {
    blocked: true,
    reason:
      "Remote manifest is empty but this machine still has tracked files; local deletes were refused. Pull or reset baseline after confirming the remote was intentionally cleared.",
  };
}

export async function recordSchedulerMassDeleteBlock(
  context: vscode.ExtensionContext,
  trigger: DeleteGuardTrigger,
  direction: "push" | "pull",
  reason: string,
  deletions: string[],
  addHistory: (
    context: vscode.ExtensionContext,
    entry: {
      timestamp: string;
      direction: "push" | "pull";
      trigger: DeleteGuardTrigger;
      fileCount: number;
      success: boolean;
      destination: "cursor-sync-storage";
      error?: string;
    }
  ) => Promise<void>
): Promise<boolean> {
  noteMassDeleteBlockedDeletions(deletions);
  const signature = massDeleteBlockSignature(direction, deletions, reason);
  if (!shouldRecordSchedulerMassDeleteBlock(signature)) {
    return false;
  }
  await addHistory(context, {
    timestamp: new Date().toISOString(),
    direction,
    trigger,
    fileCount: 0,
    success: false,
    destination: "cursor-sync-storage",
    error: reason,
  });
  return true;
}
