import { describe, expect, it } from "vitest";
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";

describe("app storage baseline sync classification", () => {
  it("pushes when only local changed since baseline", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/settings.json": "local-new" },
      { "cursor-user/settings.json": "remote-base" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/settings.json": "local-old" },
        remoteChecksums: { "cursor-user/settings.json": "remote-base" },
      }
    );

    const action = appStorageSyncActionFromClassification(classified, {
      "cursor-user/settings.json": "remote-base",
    });

    expect(action).toEqual({
      action: "push",
      keys: ["cursor-user/settings.json"],
      deletions: [],
    });
  });

  it("conflicts when both sides changed to different content", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/settings.json": "local-new" },
      { "cursor-user/settings.json": "remote-new" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/settings.json": "local-old" },
        remoteChecksums: { "cursor-user/settings.json": "remote-old" },
      }
    );

    const action = appStorageSyncActionFromClassification(classified, {
      "cursor-user/settings.json": "remote-new",
    });

    expect(action).toEqual({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });
  });

  it("does not pull-push when only local changed", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/settings.json": "local-new" },
      { "cursor-user/settings.json": "remote-base" },
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/settings.json": "local-old" },
        remoteChecksums: { "cursor-user/settings.json": "remote-base" },
      }
    );

    expect(classified.pullKeys).toEqual([]);
    expect(classified.pushKeys).toEqual(["cursor-user/settings.json"]);
  });
});
