import { describe, expect, it } from "vitest";
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import { GENERATED_EXTENSIONS_SYNC_KEY } from "../src/app-config-extensions-align.js";
import {
  decideSyncKey,
  isLocallyAbsentSafeToPull,
  localPresenceForKey,
} from "../src/app-storage-sync-decisions.js";

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
    enumeratedCount: 2,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    ...overrides,
  };
}

describe("staging.16 decision table safety cells", () => {
  it("U1/N3: out-of-scope on disk is skipped_unknown, never absent_eligible pull", () => {
    const s = scan({
      untrackedKeys: new Set(["dot-cursor/excluded.md"]),
      skippedUnknownKeys: new Set(["dot-cursor/excluded.md"]),
    });
    expect(localPresenceForKey("dot-cursor/excluded.md", s)).toBe("untracked");
    expect(isLocallyAbsentSafeToPull("dot-cursor/excluded.md", s)).toBe(false);
    const decision = decideSyncKey({
      syncKey: "dot-cursor/excluded.md",
      scan: s,
      baseline: undefined,
      curRemote: "remote",
    });
    expect(decision.action).toBe("noop");
  });

  it("absent_eligible requires proven set, not default", () => {
    const s = scan();
    expect(localPresenceForKey("dot-cursor/new.md", s)).toBe("skipped_unknown");
    const proven = scan({
      absentEligibleKeys: new Set(["dot-cursor/new.md"]),
    });
    expect(localPresenceForKey("dot-cursor/new.md", proven)).toBe("absent_eligible");
    expect(isLocallyAbsentSafeToPull("dot-cursor/new.md", proven)).toBe(true);
  });

  it("B8: symlink key noop does not block push on another key", () => {
    const s = scan({
      skippedUnknownKeys: new Set(["dot-cursor/link.md"]),
      checksums: { "dot-cursor/other.md": "local-other" },
    });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: {
        "dot-cursor/link.md": "was-link",
        "dot-cursor/other.md": "was-other",
      },
      remoteChecksums: {
        "dot-cursor/link.md": "remote-link",
        "dot-cursor/other.md": "was-remote",
      },
    };
    const classified = classifyAppStorageKeys(
      { "dot-cursor/other.md": "local-other" },
      {
        "dot-cursor/link.md": "remote-link-changed",
        "dot-cursor/other.md": "was-remote",
      },
      baseline,
      s
    );
    expect(classified.pullKeys).not.toContain("dot-cursor/link.md");
    expect(classified.pushKeys).toContain("dot-cursor/other.md");
    expect(classified.conflictKeys).not.toContain("dot-cursor/link.md");
    const action = appStorageSyncActionFromClassification(classified, {
      "dot-cursor/link.md": "remote-link-changed",
      "dot-cursor/other.md": "was-remote",
    });
    expect(action).toEqual({
      action: "push",
      keys: ["dot-cursor/other.md"],
      deletions: [],
    });
  });

  it("B5: delete_local requires wasLocal and matching local checksum", () => {
    const s = scan({
      checksums: { "cursor-user/only-remote.md": "local" },
    });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: {},
      remoteChecksums: { "cursor-user/only-remote.md": "was-remote" },
    };
    const classified = classifyAppStorageKeys(
      { "cursor-user/only-remote.md": "local" },
      {},
      baseline,
      s
    );
    expect(classified.remoteDeleteKeys).not.toContain("cursor-user/only-remote.md");
  });

  it("m2: deletes blocked when only generated extensions.json is enumerated", () => {
    const s = scan({
      checksums: { [GENERATED_EXTENSIONS_SYNC_KEY]: "ext" },
      enumeratedCount: 1,
      deletesAllowed: false,
      deleteBlockReason: "Local scan found no user content files while baseline has tracked keys",
    });
    expect(s.deletesAllowed).toBe(false);
    const classified = classifyAppStorageKeys(
      {},
      { "dot-cursor/a.md": "remote" },
      {
        schemaVersion: 1 as const,
        accountKey: "acct",
        destination: "cursor-sync-storage" as const,
        remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
        localChecksums: { "dot-cursor/a.md": "was" },
        remoteChecksums: { "dot-cursor/a.md": "remote" },
      },
      s
    );
    expect(classified.deleteKeys).toEqual([]);
    const action = appStorageSyncActionFromClassification(classified, {
      "dot-cursor/a.md": "remote",
    });
    expect(action.action).not.toBe("push");
  });
});
