import { describe, expect, it } from "vitest";
import {
  remoteChecksumChangedSinceBaseline,
  shouldPullAppConfigFile,
  type AppStorageBaseline,
} from "../src/app-storage-baseline.js";
import {
  formatPullSkippedFilesNotice,
  perFileHeldReasonForKey,
  type PullSkipReasonOverrides,
} from "../src/app-storage-delete-guard.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";

function emptyScan(partial: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
    excludedKeys: new Set(),
    oversizeKeys: new Set(),
    symlinkKeys: new Set(),
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
    ...partial,
  };
}

const baselineFixture: AppStorageBaseline = {
  schemaVersion: 1,
  accountKey: "acct",
  destination: "cursor-sync-storage",
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: { "dot-cursor/a.md": "local-a" },
  remoteChecksums: { "dot-cursor/a.md": "remote-a" },
};

describe("staging.33 F3 baseline before local unreadable", () => {
  it("remote unchanged on server even if local is unreadable", () => {
    expect(
      remoteChecksumChangedSinceBaseline("dot-cursor/a.md", "remote-a", baselineFixture)
    ).toBe(false);
    expect(shouldPullAppConfigFile(undefined, "remote-a")).toBe(true);
  });

  it("local differs from remote when remote changed since baseline", () => {
    expect(
      remoteChecksumChangedSinceBaseline("dot-cursor/a.md", "remote-b", baselineFixture)
    ).toBe(true);
    expect(shouldPullAppConfigFile("local-a", "remote-b")).toBe(true);
  });
});

describe("staging.33 F5 changed during write skip labels", () => {
  it("surfaces changed during write in pull skip notice", () => {
    const scan = emptyScan();
    const overrides: PullSkipReasonOverrides = new Map([
      ["dot-cursor/x.md", "changed_during_write"],
    ]);
    expect(perFileHeldReasonForKey("dot-cursor/x.md", scan, overrides)).toBe(
      "changed_during_write"
    );
    expect(formatPullSkippedFilesNotice(scan, ["dot-cursor/x.md"], overrides)).toContain(
      "changed during write"
    );
  });
});
