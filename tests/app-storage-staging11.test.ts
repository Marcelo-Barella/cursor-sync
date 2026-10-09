// @ts-nocheck
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
} from "../src/app-storage-baseline.js";
import { alignGeneratedOnlyLocalChecksums } from "../src/app-config-extensions-align.js";
import {
  localFileMissingFromBaseline,
  type LocalConfigFileScan,
} from "../src/app-config-local-scan.js";

describe("app storage staging.11", () => {
  it("unreadable local file is never classified as delete", () => {
    const scan: LocalConfigFileScan = {
      checksums: {},
      unreadableKeys: new Set(["cursor-user/secret.json"]),
      enoentKeys: new Set(),
      provablyAbsentKeys: new Set(),
      skippedUnknownKeys: new Set(["cursor-user/secret.json"]),
      untrackedKeys: new Set(),
      absentEligibleKeys: new Set(),
      deletesAllowed: true,
      enumeratedCount: 5,
      rootsHealthy: true,
      trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    };
    const classified = classifyAppStorageKeys(
      {},
      { "cursor-user/secret.json": "remote" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/secret.json": "was-local" },
        remoteChecksums: { "cursor-user/secret.json": "remote" },
      },
      scan
    );
    expect(classified.deleteKeys).toEqual([]);
    expect(classified.byKey["cursor-user/secret.json"]).toBe("unchanged");
    expect(localFileMissingFromBaseline("cursor-user/secret.json", scan)).toBe(false);
  });

  it("ENOENT-only missing file is classified as delete", () => {
    const scan: LocalConfigFileScan = {
      checksums: {},
      unreadableKeys: new Set(),
      enoentKeys: new Set(["cursor-user/gone.json"]),
      provablyAbsentKeys: new Set(["cursor-user/gone.json"]),
      skippedUnknownKeys: new Set(),
      untrackedKeys: new Set(),
      absentEligibleKeys: new Set(),
      deletesAllowed: true,
      enumeratedCount: 5,
      rootsHealthy: true,
      trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    };
    const classified = classifyAppStorageKeys(
      {},
      { "cursor-user/gone.json": "remote" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/gone.json": "was-local" },
        remoteChecksums: { "cursor-user/gone.json": "remote" },
      },
      scan
    );
    expect(classified.deleteKeys).toEqual(["cursor-user/gone.json"]);
  });

  it("both sides deleted drops baseline without conflict", () => {
    const scan: LocalConfigFileScan = {
      checksums: {},
      unreadableKeys: new Set(),
      enoentKeys: new Set(["cursor-user/gone.json"]),
      provablyAbsentKeys: new Set(["cursor-user/gone.json"]),
      skippedUnknownKeys: new Set(),
      untrackedKeys: new Set(),
      absentEligibleKeys: new Set(),
      deletesAllowed: true,
      enumeratedCount: 5,
      rootsHealthy: true,
      trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    };
    const classified = classifyAppStorageKeys(
      {},
      {},
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/gone.json": "was-local" },
        remoteChecksums: { "cursor-user/gone.json": "was-remote" },
      },
      scan
    );
    expect(classified.conflictKeys).toEqual([]);
    expect(classified.baselineRefreshKeys).toEqual(["cursor-user/gone.json"]);
    const action = appStorageSyncActionFromClassification(classified, {});
    expect(action).toEqual({
      action: "baseline_refresh",
      keys: ["cursor-user/gone.json"],
    });
  });

  it("fresh machine with empty extensions conflicts on remote settings change", () => {
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
    expect(localChecksums["cursor-user/extensions.json"]).toBeUndefined();
    const classified = classifyAppStorageKeys(
      localChecksums,
      remoteChecksums,
      undefined
    );
    const action = appStorageSyncActionFromClassification(classified, remoteChecksums);
    expect(action).toEqual({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });
  });
});
