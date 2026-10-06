import { describe, expect, it } from "vitest";
import { pullOverwriteShouldBePreselected } from "../src/app-storage-sync-decisions.js";
import {
  evaluateRemoteDeleteBatch,
  exceedsMassDeleteThreshold,
} from "../src/app-storage-delete-guard.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";

function scan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(),
    untrackedKeys: new Set(),
    absentEligibleKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 10,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    ...overrides,
  };
}

const baselineTracked = {
  schemaVersion: 1 as const,
  accountKey: "acct",
  destination: "cursor-sync-storage" as const,
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: { "cursor-user/settings.json": "local" },
  remoteChecksums: { "cursor-user/settings.json": "remote" },
};

describe("app storage staging.14 mass-delete threshold (OR)", () => {
  const cases: Array<{
    deletions: number;
    tracked: number;
    blocked: boolean;
  }> = [
    { deletions: 4, tracked: 7, blocked: true },
    { deletions: 4, tracked: 10, blocked: true },
    { deletions: 50, tracked: 100, blocked: true },
    { deletions: 3, tracked: 3, blocked: true },
    { deletions: 2, tracked: 2, blocked: true },
    { deletions: 1, tracked: 1, blocked: true },
    { deletions: 3, tracked: 10, blocked: false },
    { deletions: 1, tracked: 7, blocked: false },
  ];

  for (const { deletions, tracked, blocked } of cases) {
    it(`${deletions}/${tracked} ${blocked ? "blocked" : "allowed"}`, () => {
      expect(exceedsMassDeleteThreshold(deletions, tracked)).toBe(blocked);
      const keys = Array.from({ length: deletions }, (_, i) => `k${i}`);
      const decision = evaluateRemoteDeleteBatch(keys, tracked, "syncNow", scan());
      if (blocked) {
        expect(decision.proceed).toBe(false);
        expect(decision.needsModalConfirm).toBe(true);
      } else {
        expect(decision.proceed).toBe(true);
      }
    });
  }
});

describe("app storage staging.14 pull overwrite preselection", () => {
  it("pre-selects when baseline tracks the key (remote-only change)", () => {
    const s = scan({ checksums: { "cursor-user/settings.json": "local" } });
    expect(
      pullOverwriteShouldBePreselected(
        "cursor-user/settings.json",
        baselineTracked,
        "local",
        s,
        "remote-new"
      )
    ).toBe(true);
  });

  it("leaves unselected when no baseline entry and local differs", () => {
    const baselineOtherOnly = {
      ...baselineTracked,
      localChecksums: { "cursor-user/other.json": "local" },
      remoteChecksums: { "cursor-user/other.json": "remote" },
    };
    const s = scan({ checksums: { "cursor-user/settings.json": "only-local" } });
    expect(
      pullOverwriteShouldBePreselected(
        "cursor-user/settings.json",
        baselineOtherOnly,
        "only-local",
        s,
        "remote"
      )
    ).toBe(false);
  });
});
