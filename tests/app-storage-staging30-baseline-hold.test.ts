import { describe, expect, it } from "vitest";
import {
  classifyAppStorageKeys,
  appStorageSyncActionFromClassification,
} from "../src/app-storage-baseline.js";
import { decideSyncKey } from "../src/app-storage-sync-decisions.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import {
  applyLocalPathClassificationToScan,
  type LocalPathHeldHints,
} from "../src/app-config-disk-probe.js";

const KEY = "dot-cursor/rules/r8.mdc";

function baseScan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
    excludedKeys: new Set(),
    oversizeKeys: new Set(),
    symlinkKeys: new Set(),
    underSymlinkedDirKeys: new Set(),
    symlinkedFolderLabels: {},
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(),
    untrackedKeys: new Set(),
    absentEligibleKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 0,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    ...overrides,
  };
}

const baseline = {
  schemaVersion: 1 as const,
  accountKey: "acct",
  destination: "cursor-sync-storage" as const,
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: {
    [KEY]: "local-old",
    "dot-cursor/other.md": "same",
  },
  remoteChecksums: {
    [KEY]: "remote-old",
    "dot-cursor/other.md": "same",
  },
};

describe("P0 excluded/oversize must not baseline_refresh", () => {
  it("excluded baseline key stays skipped_unknown and does not refresh baseline", () => {
    const scan = baseScan({
      excludedKeys: new Set([KEY]),
      skippedUnknownKeys: new Set([KEY]),
    });
    const decision = decideSyncKey({
      syncKey: KEY,
      scan,
      baseline,
      curLocal: undefined,
      curRemote: undefined,
    });
    expect(decision.action).not.toBe("baseline_refresh");
    expect(decision.action).toBe("noop");
  });

  it("peer delete while key is excluded does not become push on restore", () => {
    const scanAfterRestore = baseScan({
      checksums: { [KEY]: "local-old" },
    });
    const classified = classifyAppStorageKeys(
      { [KEY]: "local-old", "dot-cursor/other.md": "same" },
      { "dot-cursor/other.md": "same" },
      baseline,
      scanAfterRestore
    );
    const action = appStorageSyncActionFromClassification(classified, {
      "dot-cursor/other.md": "same",
    });
    expect(classified.pushKeys).not.toContain(KEY);
    expect(action.action).not.toBe("push");
  });

  it("exclude-all scan triggers empty-scan hold (deletes blocked)", () => {
    const scan = baseScan({
      excludedKeys: new Set(Object.keys(baseline.localChecksums)),
      skippedUnknownKeys: new Set(Object.keys(baseline.localChecksums)),
      deletesAllowed: false,
      deleteBlockReason:
        "Local scan found no user content files while baseline has tracked keys",
    });
    expect(scan.deletesAllowed).toBe(false);
    expect(scan.deleteBlockReason).toContain("no user content");
  });

  it("mutation: adding excluded keys to untracked re-enables baseline_refresh", () => {
    const hints: LocalPathHeldHints = {
      excluded: true,
      oversize: false,
      symlink: false,
      unreadable: false,
    };
    const scan = baseScan();
    applyLocalPathClassificationToScan(scan, KEY, "skipped_unknown", hints);
    expect(scan.untrackedKeys.has(KEY)).toBe(false);

    const broken = baseScan();
    broken.excludedKeys!.add(KEY);
    broken.untrackedKeys.add(KEY);
    broken.skippedUnknownKeys.add(KEY);
    const decision = decideSyncKey({
      syncKey: KEY,
      scan: broken,
      baseline,
      curLocal: undefined,
      curRemote: undefined,
    });
    expect(decision.action).toBe("baseline_refresh");
  });
});

describe("b5g single-file exclude then restore", () => {
  it("does not push over peer delete when remote missing", () => {
    const scan = baseScan({
      checksums: { [KEY]: "local-old" },
    });
    const classified = classifyAppStorageKeys(
      { [KEY]: "local-old" },
      {},
      baseline,
      scan
    );
    expect(classified.pushKeys).not.toContain(KEY);
    expect(
      classified.conflictKeys.includes(KEY) ||
        classified.remoteDeleteKeys.includes(KEY) ||
        classified.unchangedKeys.includes(KEY)
    ).toBe(true);
  });
});
