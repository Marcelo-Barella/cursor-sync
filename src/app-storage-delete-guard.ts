import type * as vscode from "vscode";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";

export type DeleteGuardTrigger = "manual" | "scheduled" | "syncNow" | "startup";

export interface MassDeleteDecision {
  proceed: boolean;
  needsModalConfirm: boolean;
  schedulerBlocked: boolean;
  reason?: string;
}

export const MASS_DELETE_MAX_WITHOUT_CONFIRM = 3;
export const MASS_DELETE_FRACTION_WITHOUT_CONFIRM = 0.5;

let lastSchedulerMassDeleteBlockReason: string | undefined;

export function resetSchedulerMassDeleteBlockDedupe(): void {
  lastSchedulerMassDeleteBlockReason = undefined;
}

export function shouldRecordSchedulerMassDeleteBlock(reason: string): boolean {
  if (reason === lastSchedulerMassDeleteBlockReason) {
    return false;
  }
  lastSchedulerMassDeleteBlockReason = reason;
  return true;
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
    deletionCount > trackedKeyCount * MASS_DELETE_FRACTION_WITHOUT_CONFIRM
  ) {
    return true;
  }
  return false;
}

export function evaluateRemoteDeleteBatch(
  deletions: string[],
  trackedKeyCount: number,
  trigger: DeleteGuardTrigger,
  scan: LocalConfigFileScan
): MassDeleteDecision {
  if (deletions.length === 0) {
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

  if (!exceedsMassDeleteThreshold(deletions.length, trackedKeyCount)) {
    return { proceed: true, needsModalConfirm: false, schedulerBlocked: false };
  }

  const reason = `Refusing to delete ${deletions.length} of ${trackedKeyCount} tracked files without confirmation`;
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
  if (deletions.length === 0) {
    return [];
  }

  const decision = evaluateRemoteDeleteBatch(
    deletions,
    trackedKeyCount,
    trigger,
    scan
  );

  if (decision.proceed) {
    return deletions;
  }

  if (decision.schedulerBlocked) {
    return [];
  }

  if (decision.needsModalConfirm) {
    const ok = await options.modalConfirm(
      decision.reason ??
        `Delete ${deletions.length} ${options.direction === "push" ? "remote" : "local"} file(s)?`
    );
    return ok ? deletions : [];
  }

  return [];
}

export async function recordSchedulerMassDeleteBlock(
  context: vscode.ExtensionContext,
  trigger: DeleteGuardTrigger,
  direction: "push" | "pull",
  reason: string,
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
  if (!shouldRecordSchedulerMassDeleteBlock(reason)) {
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
