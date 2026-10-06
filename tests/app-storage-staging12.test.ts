import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
}));
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
  filterScheduledAppStoragePullKeys,
} from "../src/app-storage-baseline.js";
import { alignGeneratedOnlyLocalChecksums } from "../src/app-config-extensions-align.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";

const emptyScan: LocalConfigFileScan = {
  checksums: {},
  unreadableKeys: new Set(),
  enoentKeys: new Set(),
};

describe("app storage staging.12", () => {
  it("classifies real local delete when file is absent from scan (not only enoentKeys)", () => {
    const classified = classifyAppStorageKeys(
      {},
      { "cursor-user/commands/r8.md": "remote" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/commands/r8.md": "was-local" },
        remoteChecksums: { "cursor-user/commands/r8.md": "remote" },
      },
      emptyScan
    );
    expect(classified.deleteKeys).toEqual(["cursor-user/commands/r8.md"]);
    const action = appStorageSyncActionFromClassification(classified, {
      "cursor-user/commands/r8.md": "remote",
    });
    expect(action).toEqual({
      action: "push",
      keys: [],
      deletions: ["cursor-user/commands/r8.md"],
    });
  });

  it("both sides deleted without enoentKeys yields baseline_refresh", () => {
    const classified = classifyAppStorageKeys(
      {},
      {},
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/commands/r8.md": "was-local" },
        remoteChecksums: { "cursor-user/commands/r8.md": "was-remote" },
      },
      emptyScan
    );
    expect(classified.baselineRefreshKeys).toEqual(["cursor-user/commands/r8.md"]);
  });

  it("scheduled pull strips keys that have no baseline entry", () => {
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    };
    expect(
      filterScheduledAppStoragePullKeys(
        ["cursor-user/settings.json", "cursor-user/new.json"],
        baseline
      )
    ).toEqual(["cursor-user/settings.json"]);
    expect(filterScheduledAppStoragePullKeys(["cursor-user/new.json"], undefined)).toEqual(
      []
    );
  });

  it("no baseline local vs remote mismatch is conflict (scheduler must not auto-overwrite)", () => {
    const remoteChecksums = {
      "cursor-user/settings.json": "remote-settings",
    };
    let localChecksums = {
      "cursor-user/settings.json": "local-default",
    };
    localChecksums = alignGeneratedOnlyLocalChecksums(
      localChecksums,
      remoteChecksums,
      undefined,
      true
    );
    const classified = classifyAppStorageKeys(
      localChecksums,
      remoteChecksums,
      undefined,
      emptyScan
    );
    expect(classified.conflictKeys).toContain("cursor-user/settings.json");
    expect(filterScheduledAppStoragePullKeys(classified.pullKeys, undefined)).toEqual([]);
  });

  it("after mutual delete, re-added same content is push not remote_delete", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/foo.json": "same-hash" },
      {},
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: {},
        remoteChecksums: {},
      },
      emptyScan
    );
    expect(classified.remoteDeleteKeys).toEqual([]);
    expect(classified.pushKeys).toEqual(["cursor-user/foo.json"]);
  });
});
