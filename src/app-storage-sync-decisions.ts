import type { AppStorageBaseline } from "./app-storage-baseline.js";
import { baselineHasEntries } from "./app-storage-baseline.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";
import type { SyncDeclineEntry } from "./app-storage-sync-declines.js";

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
  if (scan.absentEligibleKeys.has(syncKey)) {
    return "absent_eligible";
  }
  return "skipped_unknown";
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
  return local === "provably_absent" || local === "absent_eligible";
}

export function shouldAllowPullWriteForKey(
  syncKey: string,
  scan: LocalConfigFileScan
): boolean {
  const local = localPresenceForKey(syncKey, scan);
  return local === "present" || local === "provably_absent" || local === "absent_eligible";
}

function declineBlocksDecision(
  decision: SyncKeyDecision,
  declines: SyncDeclineEntry | undefined,
  curLocal?: string
): SyncKeyDecision {
  if (!declines) {
    return decision;
  }
  if (
    decision.action === "pull" &&
    declines.pullOverwriteChecksum !== undefined &&
    (curLocal ?? "") === declines.pullOverwriteChecksum
  ) {
    return { action: "noop", pullPreselected: false };
  }
  if (decision.action === "delete_local" && declines.keepLocalAgainstRemoteDelete) {
    return { action: "noop", pullPreselected: false };
  }
  return decision;
}

export function decideSyncKey(input: {
  syncKey: string;
  scan: LocalConfigFileScan;
  baseline: AppStorageBaseline | undefined;
  curLocal?: string;
  curRemote?: string;
  declines?: SyncDeclineEntry;
}): SyncKeyDecision {
  const { syncKey, scan, baseline, curLocal, curRemote, declines } = input;
  const local = localPresenceForKey(syncKey, scan);
  const hasBaseline = baselineHasEntries(baseline);
  const wasLocal = baseline?.localChecksums[syncKey];
  const wasRemote = baseline?.remoteChecksums[syncKey];

  if (local === "untracked") {
    if (hasBaseline && (wasLocal !== undefined || wasRemote !== undefined)) {
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
      return declineBlocksDecision(
        { action: pre ? "pull" : "noop", pullPreselected: pre },
        declines,
        curLocal
      );
    }
    if (!remoteExists && localExists) {
      return { action: "push", pullPreselected: false };
    }
    return { action: "noop", pullPreselected: false };
  }

  if (wasLocal !== undefined && curLocal === undefined) {
    if (local !== "provably_absent" && local !== "absent_eligible") {
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

  if (
    wasLocal !== undefined &&
    wasRemote !== undefined &&
    curRemote === undefined &&
    curLocal !== undefined &&
    curLocal === wasLocal
  ) {
    return declineBlocksDecision(
      { action: "delete_local", pullPreselected: false },
      declines,
      curLocal
    );
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

  return declineBlocksDecision(
    { action: "pull", pullPreselected: true },
    declines,
    curLocal
  );
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

export function isEffectiveSyncClassification(
  classification: import("./app-storage-baseline.js").AppStorageKeyClassification
): boolean {
  return classification !== "unchanged" && classification !== "baseline_refresh";
}
