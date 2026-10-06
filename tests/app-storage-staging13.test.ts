import { describe, expect, it, vi } from "vitest";
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
  filterScheduledAppStoragePullKeys,
} from "../src/app-storage-baseline.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import {
  evaluateRemoteDeleteBatch,
  MASS_DELETE_MAX_WITHOUT_CONFIRM,
} from "../src/app-storage-delete-guard.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
}));

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
    enumeratedCount: 6,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    ...overrides,
  };
}

const baseline6 = {
  schemaVersion: 1 as const,
  accountKey: "acct",
  destination: "cursor-sync-storage" as const,
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: {
    "dot-cursor/commands/a.md": "h1",
    "dot-cursor/commands/b.md": "h2",
    "dot-cursor/commands/c.md": "h3",
    "dot-cursor/commands/d.md": "h4",
    "dot-cursor/commands/e.md": "h5",
    "dot-cursor/commands/f.md": "h6",
  },
  remoteChecksums: {
    "dot-cursor/commands/a.md": "r1",
    "dot-cursor/commands/b.md": "r2",
    "dot-cursor/commands/c.md": "r3",
    "dot-cursor/commands/d.md": "r4",
    "dot-cursor/commands/e.md": "r5",
    "dot-cursor/commands/f.md": "r6",
  },
};

describe("app storage staging.13 mass-delete safety", () => {
  it("does not delete when key is skipped_unknown (symlink-like gap in scan)", () => {
    const s = scan({
      skippedUnknownKeys: new Set(["dot-cursor/commands/a.md"]),
      unreadableKeys: new Set(["dot-cursor/commands/a.md"]),
    });
    const classified = classifyAppStorageKeys({}, baseline6.remoteChecksums, baseline6, s);
    expect(classified.deleteKeys).toEqual([]);
    expect(classified.byKey["dot-cursor/commands/a.md"]).toBe("unchanged");
  });

  it("deletes only provably_absent keys", () => {
    const s = scan({
      provablyAbsentKeys: new Set(["dot-cursor/commands/r8.md"]),
      enoentKeys: new Set(["dot-cursor/commands/r8.md"]),
    });
    const classified = classifyAppStorageKeys(
      {},
      { ...baseline6.remoteChecksums, "dot-cursor/commands/r8.md": "rx" },
      {
        ...baseline6,
        localChecksums: {
          ...baseline6.localChecksums,
          "dot-cursor/commands/r8.md": "local",
        },
        remoteChecksums: {
          ...baseline6.remoteChecksums,
          "dot-cursor/commands/r8.md": "rx",
        },
      },
      s
    );
    expect(classified.deleteKeys).toEqual(["dot-cursor/commands/r8.md"]);
  });

  it("drops untracked keys from baseline without remote delete", () => {
    const s = scan({
      untrackedKeys: new Set(["dot-cursor/commands/removed-by-glob.md"]),
    });
    const classified = classifyAppStorageKeys(
      {},
      baseline6.remoteChecksums,
      {
        ...baseline6,
        localChecksums: {
          ...baseline6.localChecksums,
          "dot-cursor/commands/removed-by-glob.md": "x",
        },
      },
      s
    );
    expect(classified.deleteKeys).toEqual([]);
    expect(classified.baselineRefreshKeys).toContain(
      "dot-cursor/commands/removed-by-glob.md"
    );
  });

  it("blocks deletes when scan is empty with baseline keys", () => {
    const s = scan({
      deletesAllowed: false,
      enumeratedCount: 0,
      deleteBlockReason: "Local scan returned no files",
    });
    const classified = classifyAppStorageKeys(
      {},
      baseline6.remoteChecksums,
      baseline6,
      s
    );
    expect(classified.deleteKeys).toEqual([]);
    const decision = evaluateRemoteDeleteBatch(
      ["dot-cursor/commands/a.md"],
      6,
      "scheduled",
      s
    );
    expect(decision.proceed).toBe(false);
    expect(decision.schedulerBlocked).toBe(true);
  });

  it("mass-delete threshold requires confirm for manual and blocks scheduler", () => {
    const s = scan();
    const keys = [
      "dot-cursor/commands/a.md",
      "dot-cursor/commands/b.md",
      "dot-cursor/commands/c.md",
      "dot-cursor/commands/d.md",
    ];
    const manual = evaluateRemoteDeleteBatch(keys, 6, "syncNow", s);
    expect(manual.proceed).toBe(false);
    expect(manual.needsModalConfirm).toBe(true);
    const scheduled = evaluateRemoteDeleteBatch(keys, 6, "scheduled", s);
    expect(scheduled.schedulerBlocked).toBe(true);
    expect(
      evaluateRemoteDeleteBatch(
        keys.slice(0, MASS_DELETE_MAX_WITHOUT_CONFIRM),
        6,
        "scheduled",
        s
      ).proceed
    ).toBe(true);
  });

  it("scheduler auto-pulls absent-local remote keys without baseline", () => {
    const remote = { "cursor-user/settings.json": "remote" };
    const absentScan = scan({
      absentEligibleKeys: new Set(["cursor-user/settings.json"]),
      provablyAbsentKeys: new Set(["cursor-user/settings.json"]),
    });
    const classified = classifyAppStorageKeys({}, remote, undefined, absentScan);
    expect(classified.pullKeys).toEqual(["cursor-user/settings.json"]);
    expect(
      filterScheduledAppStoragePullKeys(
        classified.pullKeys,
        undefined,
        absentScan,
        remote
      )
    ).toEqual(["cursor-user/settings.json"]);
  });

  it("no-baseline local present and different remains conflict", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/settings.json": "local" },
      { "cursor-user/settings.json": "remote" },
      undefined,
      scan()
    );
    const action = appStorageSyncActionFromClassification(classified, {
      "cursor-user/settings.json": "remote",
    });
    expect(action).toEqual({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });
  });

  it("mutual delete with provably_absent local", () => {
    const s = scan({
      provablyAbsentKeys: new Set(["dot-cursor/commands/gone.md"]),
      enoentKeys: new Set(["dot-cursor/commands/gone.md"]),
    });
    const classified = classifyAppStorageKeys(
      {},
      {},
      {
        ...baseline6,
        localChecksums: {
          "dot-cursor/commands/gone.md": "was",
        },
        remoteChecksums: {
          "dot-cursor/commands/gone.md": "was-remote",
        },
      },
      s
    );
    expect(classified.baselineRefreshKeys).toEqual(["dot-cursor/commands/gone.md"]);
  });
});
