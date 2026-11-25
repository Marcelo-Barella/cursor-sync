import { describe, expect, it } from "vitest";
import {
  appStorageAccountKey,
  accountKeyFromAppSession,
} from "../src/app-session-identity.js";
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";

function jwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub }), "utf8").toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("app storage staging.10", () => {
  it("keys baseline by userId and api base, not session hash", () => {
    const api = "https://api.example.com";
    const a = appStorageAccountKey(jwtWithSub("user-1"), api);
    const b = appStorageAccountKey(jwtWithSub("user-1"), api);
    const otherSession = appStorageAccountKey(jwtWithSub("user-2"), api);
    expect(a).toBe(b);
    expect(a).not.toBe(otherSession);
    expect(a).not.toBe(accountKeyFromAppSession(jwtWithSub("user-1")));
  });

  it("classifies remote delete when local matches baseline", () => {
    const classified = classifyAppStorageKeys(
      { "cursor-user/foo.json": "same" },
      {},
      {
        schemaVersion: 1,
        accountKey: "acct",
        destination: "cursor-sync-storage",
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "cursor-user/foo.json": "same" },
        remoteChecksums: { "cursor-user/foo.json": "remote-was" },
      }
    );
    expect(classified.remoteDeleteKeys).toEqual(["cursor-user/foo.json"]);
    const action = appStorageSyncActionFromClassification(classified, {});
    expect(action).toEqual({
      action: "pull",
      keys: [],
      remoteDeletions: ["cursor-user/foo.json"],
    });
  });
});
