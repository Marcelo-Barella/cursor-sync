import { describe, expect, it } from "vitest";
import {
  classifyAppStorageKeys,
  appStorageSyncActionFromClassification,
} from "../src/app-storage-baseline.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import {
  decideSyncKey,
  filterScheduledAppStoragePullKeys,
  pullOverwriteShouldBePreselected,
} from "../src/app-storage-sync-decisions.js";
import { resolveMassDeleteBatch } from "../src/app-storage-delete-guard.js";

function scan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(),
    untrackedKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 3,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    ...overrides,
  };
}

const baseline = {
  schemaVersion: 1 as const,
  accountKey: "acct",
  destination: "cursor-sync-storage" as const,
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: { "cursor-user/a.json": "local-a" },
  remoteChecksums: { "cursor-user/a.json": "remote-a" },
};

describe("sync decision table cells", () => {
  const cells: Array<{
    name: string;
    baseline: typeof baseline | undefined;
    local: LocalConfigFileScan;
    curLocal?: string;
    curRemote?: string;
    key: string;
    action: string;
    pullPreselected?: boolean;
  }> = [
    {
      name: "no baseline local differs remote",
      baseline: undefined,
      local: scan({ checksums: { "cursor-user/s.json": "L" } }),
      curLocal: "L",
      curRemote: "R",
      key: "cursor-user/s.json",
      action: "conflict",
      pullPreselected: false,
    },
    {
      name: "no baseline remote only absent eligible",
      baseline: undefined,
      local: scan({ provablyAbsentKeys: new Set(["cursor-user/n.json"]) }),
      curRemote: "R",
      key: "cursor-user/n.json",
      action: "pull",
      pullPreselected: true,
    },
    {
      name: "tracked remote changed local same",
      baseline,
      local: scan({ checksums: { "cursor-user/a.json": "local-a" } }),
      curLocal: "local-a",
      curRemote: "remote-b",
      key: "cursor-user/a.json",
      action: "pull",
      pullPreselected: true,
    },
    {
      name: "tracked provably absent remote same",
      baseline,
      local: scan({ provablyAbsentKeys: new Set(["cursor-user/a.json"]) }),
      curRemote: "remote-a",
      key: "cursor-user/a.json",
      action: "delete_remote",
    },
    {
      name: "skipped never pulls",
      baseline,
      local: scan({ skippedUnknownKeys: new Set(["cursor-user/a.json"]) }),
      curRemote: "remote-b",
      key: "cursor-user/a.json",
      action: "noop",
    },
  ];

  for (const cell of cells) {
    it(cell.name, () => {
      const decision = decideSyncKey({
        syncKey: cell.key,
        scan: cell.local,
        baseline: cell.baseline,
        curLocal: cell.curLocal,
        curRemote: cell.curRemote,
      });
      expect(decision.action).toBe(cell.action);
      if (cell.pullPreselected !== undefined) {
        expect(decision.pullPreselected).toBe(cell.pullPreselected);
      }
    });
  }
});

describe("staging.15 entry points", () => {
  it("classify + sync action for delete-only remote", () => {
    const s = scan({
      provablyAbsentKeys: new Set(["cursor-user/a.json"]),
    });
    const classified = classifyAppStorageKeys(
      {},
      { "cursor-user/a.json": "remote-a" },
      baseline,
      s
    );
    expect(classified.deleteKeys).toEqual(["cursor-user/a.json"]);
    const action = appStorageSyncActionFromClassification(classified, {
      "cursor-user/a.json": "remote-a",
    });
    expect(action).toEqual({
      action: "push",
      keys: [],
      deletions: ["cursor-user/a.json"],
    });
  });

  it("scheduler keeps tracked remote-change pulls when local file present", () => {
    const s = scan({
      checksums: { "cursor-user/settings.json": "local" },
      provablyAbsentKeys: new Set(["cursor-user/new.json"]),
    });
    const keys = filterScheduledAppStoragePullKeys(
      ["cursor-user/settings.json", "cursor-user/new.json"],
      {
        ...baseline,
        localChecksums: { "cursor-user/settings.json": "local" },
        remoteChecksums: { "cursor-user/settings.json": "was-remote" },
      },
      s,
      {
        "cursor-user/settings.json": "remote-new",
        "cursor-user/new.json": "nx",
      }
    );
    expect(keys).toEqual(["cursor-user/settings.json", "cursor-user/new.json"]);
  });

  it("no-baseline differing local is not pull-preselected", () => {
    const s = scan({ checksums: { "cursor-user/s.json": "local" } });
    expect(
      pullOverwriteShouldBePreselected(
        "cursor-user/s.json",
        undefined,
        "local",
        s,
        "remote"
      )
    ).toBe(false);
  });

  it("resolveMassDeleteBatch returns a copy when proceeding", async () => {
    const input = ["a", "b"];
    const out = await resolveMassDeleteBatch(input, 10, "syncNow", scan(), {
      direction: "push",
      modalConfirm: async () => true,
    });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    input.length = 0;
    expect(out).toEqual(["a", "b"]);
  });
});
