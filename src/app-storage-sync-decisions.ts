/**
 * App storage sync decision table (single source of truth).
 *
 * Dimensions per sync key:
 * - Baseline: absent | present (tracked in baseline store)
 * - Local: present | provably_absent | skipped_unknown | untracked
 * - Remote: present_same | present_changed | absent
 *
 * Actions: push | pull | delete_remote | delete_local | conflict | noop | baseline_refresh
 * pullPreselected: manual pull overwrite picker default when action is pull
 *
 * | Baseline | Local            | Remote          | Action           | Pull preselected |
 * |----------|------------------|-----------------|------------------|------------------|
 * | absent   | present          | absent          | push             | n/a              |
 * | absent   | present          | present_same    | baseline_refresh | n/a              |
 * | absent   | present          | present_changed | conflict         | false            |
 * | absent   | provably_absent  | present_*       | pull             | true (absent)    |
 * | absent   | provably_absent  | absent          | noop             | n/a              |
 * | absent   | skipped/untracked| present_*       | noop             | false            |
 * | present  | present          | absent          | remote_delete    | n/a              |
 * | present  | present          | present_same    | noop             | n/a              |
 * | present  | present          | present_changed | pull             | true             |
 * | present  | provably_absent  | absent          | baseline_refresh | n/a              |
 * | present  | provably_absent  | present_same    | delete_remote    | n/a              |
 * | present  | provably_absent  | present_changed | conflict         | false            |
 * | present  | skipped/untracked| *               | noop             | false            |
 * | present  | untracked        | (local gone)    | baseline_refresh | n/a              |
 *
 * Scheduled pull: pull keys except skipped/untracked; absent-local uses safe-absent rule;
 * tracked remote-only change pulls even when local file is present on disk.
 * Push never uploads skipped/untracked keys. Deletes require provably_absent + deletesAllowed.
 */

import type { AppStorageBaseline } from "./app-storage-baseline.js";
import { baselineHasEntries, baselineKeyTracked } from "./app-storage-baseline.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";

export type LocalPresence =
  | "present"
  | "provably_absent"
  | "skipped_unknown"
  | "untracked"
  | "absent_eligible";

export type RemotePresence = "absent" | "present_same" | "present_changed";

export type SyncDecisionAction =
  | "push"
  | "pull"
  | "delete_remote"
  | "delete_local"
  | "conflict"
  | "noop"
  | "baseline_refresh";

export interface SyncKeyDecision {
  action: SyncDecisionAction;
  pullPreselected: boolean;
}

export function localPresenceForKey(
  syncKey: string,
  scan: LocalConfigFileScan
): LocalPresence {
  if (scan.untrackedKeys.has(syncKey)) {
    return "untracked";
  }
  if (scan.skippedUnknownKeys.has(syncKey)) {
    return "skipped_unknown";
  }
  if (scan.checksums[syncKey] !== undefined) {
    return "present";
  }
  if (scan.provablyAbsentKeys.has(syncKey)) {
    return "provably_absent";
  }
  return "absent_eligible";
}

export function remotePresenceForKey(
  syncKey: string,
  remoteChecksum: string | undefined,
  baseline: AppStorageBaseline | undefined
): RemotePresence {
  if (remoteChecksum === undefined) {
    return "absent";
  }
  const wasRemote = baseline?.remoteChecksums[syncKey];
  if (!baselineHasEntries(baseline) || wasRemote === undefined) {
    return "present_changed";
  }
  if (remoteChecksum === wasRemote) {
    return "present_same";
  }
  return "present_changed";
}

export function isLocallyAbsentSafeToPull(
  syncKey: string,
  scan: LocalConfigFileScan
): boolean {
  const local = localPresenceForKey(syncKey, scan);
  if (local === "untracked" || local === "skipped_unknown" || local === "present") {
    return false;
  }
  if (local === "provably_absent" || local === "absent_eligible") {
    return true;
  }
  return false;
}

export function shouldAllowPullWriteForKey(
  syncKey: string,
  scan: LocalConfigFileScan
): boolean {
  const local = localPresenceForKey(syncKey, scan);
  return local !== "untracked" && local !== "skipped_unknown";
}

export function decideSyncKey(input: {
  syncKey: string;
  scan: LocalConfigFileScan;
  baseline: AppStorageBaseline | undefined;
  curLocal?: string;
  curRemote?: string;
}): SyncKeyDecision {
  const { syncKey, scan, baseline, curLocal, curRemote } = input;
  const local = localPresenceForKey(syncKey, scan);
  const hasBaseline = baselineHasEntries(baseline);
  const wasLocal = baseline?.localChecksums[syncKey];
  const wasRemote = baseline?.remoteChecksums[syncKey];

  if (local === "untracked") {
    if (hasBaseline && wasLocal !== undefined && curLocal === undefined) {
      return { action: "baseline_refresh", pullPreselected: false };
    }
    return { action: "noop", pullPreselected: false };
  }

  if (local === "skipped_unknown") {
    return { action: "noop", pullPreselected: false };
  }

  if (!hasBaseline) {
    const remoteExists = curRemote !== undefined;
    const localExists = curLocal !== undefined;
    if (remoteExists && localExists) {
      if (curLocal === curRemote) {
        return { action: "baseline_refresh", pullPreselected: false };
      }
      return { action: "conflict", pullPreselected: false };
    }
    if (remoteExists && !localExists) {
      const pre = isLocallyAbsentSafeToPull(syncKey, scan);
      return { action: pre ? "pull" : "noop", pullPreselected: pre };
    }
    if (!remoteExists && localExists) {
      return { action: "push", pullPreselected: false };
    }
    return { action: "noop", pullPreselected: false };
  }

  if (wasLocal !== undefined && curLocal === undefined) {
    if (local !== "provably_absent") {
      return { action: "noop", pullPreselected: false };
    }
    if (wasRemote !== undefined && curRemote === undefined) {
      return { action: "baseline_refresh", pullPreselected: false };
    }
    if (curRemote !== wasRemote) {
      return { action: "conflict", pullPreselected: false };
    }
    return { action: "delete_remote", pullPreselected: false };
  }

  if (wasRemote !== undefined && curRemote === undefined && curLocal === wasLocal) {
    return { action: "delete_local", pullPreselected: false };
  }

  const localChanged = curLocal !== wasLocal;
  const remoteChanged = curRemote !== wasRemote;

  if (!localChanged && !remoteChanged) {
    return { action: "noop", pullPreselected: false };
  }

  if (localChanged && remoteChanged) {
    if (curLocal === curRemote) {
      return { action: "baseline_refresh", pullPreselected: false };
    }
    return { action: "conflict", pullPreselected: false };
  }

  if (localChanged) {
    return { action: "push", pullPreselected: false };
  }

  if (curRemote === undefined) {
    return { action: "delete_local", pullPreselected: false };
  }

  return { action: "pull", pullPreselected: true };
}

export function pullOverwriteShouldBePreselected(
  syncKey: string,
  pullBaseline: AppStorageBaseline | undefined,
  localChecksum: string | undefined,
  scan: LocalConfigFileScan,
  remoteChecksum?: string
): boolean {
  if (!shouldAllowPullWriteForKey(syncKey, scan)) {
    return false;
  }
  const decision = decideSyncKey({
    syncKey,
    scan,
    baseline: pullBaseline,
    curLocal: localChecksum,
    curRemote: remoteChecksum,
  });
  if (decision.action === "conflict" || decision.action === "noop") {
    return false;
  }
  if (decision.action !== "pull") {
    return false;
  }
  return decision.pullPreselected;
}

export function filterScheduledAppStoragePullKeys(
  keys: string[],
  baseline: AppStorageBaseline | undefined,
  localScan: LocalConfigFileScan,
  remoteChecksums: Record<string, string>
): string[] {
  return keys.filter((key) => {
    if (!shouldAllowPullWriteForKey(key, localScan)) {
      return false;
    }
    const wasLocal = baseline?.localChecksums[key];
    const wasRemote = baseline?.remoteChecksums[key];
    const curLocal = localScan.checksums[key];
    const curRemote = remoteChecksums[key];
    if (
      baseline &&
      wasRemote !== undefined &&
      curRemote !== undefined &&
      curRemote !== wasRemote &&
      wasLocal !== undefined &&
      curLocal === wasLocal
    ) {
      return true;
    }
    if (localScan.checksums[key] !== undefined) {
      return false;
    }
    return isLocallyAbsentSafeToPull(key, localScan);
  });
}
