import { describe, expect, it } from "vitest";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import {
  formatPerFileSyncHeldNotice,
  formatPullHeldRemoteUpdateNotice,
  perFileHeldReasonForKey,
} from "../src/app-storage-delete-guard.js";

function emptyScan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
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
    ...overrides,
  };
}

describe("M3 held notice categories", () => {
  it("labels excluded, oversize, symlink, and unreadable separately with names", () => {
    const scan = emptyScan({
      excludedKeys: new Set(["dot-cursor/ex1.md"]),
      untrackedKeys: new Set(["dot-cursor/ex1.md", "dot-cursor/ov2.md"]),
      oversizeKeys: new Set(["dot-cursor/ov2.md"]),
      symlinkKeys: new Set(["dot-cursor/link.md"]),
      skippedUnknownKeys: new Set([
        "dot-cursor/ex1.md",
        "dot-cursor/ov2.md",
        "dot-cursor/link.md",
        "cursor-user/unread.json",
      ]),
      unreadableKeys: new Set([
        "dot-cursor/ex1.md",
        "dot-cursor/ov2.md",
        "dot-cursor/link.md",
        "cursor-user/unread.json",
      ]),
    });
    const held = [
      "dot-cursor/ex1.md",
      "dot-cursor/ov2.md",
      "dot-cursor/link.md",
      "cursor-user/unread.json",
    ];
    const msg = formatPerFileSyncHeldNotice(scan, held);
    expect(msg).toMatch(/1 excluded \(dot-cursor\/ex1\.md\)/);
    expect(msg).toMatch(/1 oversize \(dot-cursor\/ov2\.md\)/);
    expect(msg).toMatch(/1 symlink \(dot-cursor\/link\.md\)/);
    expect(msg).toMatch(/1 unreadable \(cursor-user\/unread\.json\)/);
    expect(msg).not.toMatch(/unreadable.*4/);
  });
});

describe("M4 pull held remote update notice", () => {
  it("names a single held remote file with its reason", () => {
    const scan = emptyScan({
      symlinkKeys: new Set(["dot-cursor/r8.mdc"]),
      skippedUnknownKeys: new Set(["dot-cursor/r8.mdc"]),
      unreadableKeys: new Set(["dot-cursor/r8.mdc"]),
    });
    expect(perFileHeldReasonForKey("dot-cursor/r8.mdc", scan)).toBe("symlink");
    expect(formatPullHeldRemoteUpdateNotice(scan, ["dot-cursor/r8.mdc"])).toBe(
      "1 remote update not applied: dot-cursor/r8.mdc is a symlink."
    );
  });
});

describe("M5 never-synced symlink labeling", () => {
  it("classifies symlink not in baseline as never-synced reason", () => {
    const scan = emptyScan({
      symlinkKeys: new Set(["dot-cursor/r21new.md"]),
      skippedUnknownKeys: new Set(["dot-cursor/r21new.md"]),
    });
    expect(perFileHeldReasonForKey("dot-cursor/r21new.md", scan)).toBe("symlink");
    expect(perFileHeldReasonForKey("cursor-user/settings.json", scan)).toBe(
      "unsafe_path"
    );
  });
});
