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

  const threshold = Math.max(
    MASS_DELETE_MAX_WITHOUT_CONFIRM,
    Math.ceil(trackedKeyCount * MASS_DELETE_FRACTION_WITHOUT_CONFIRM)
  );

  if (deletions.length > threshold) {
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

  return { proceed: true, needsModalConfirm: false, schedulerBlocked: false };
}
