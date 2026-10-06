import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  applyLocalPathClassificationToScan,
  classifyLocalPath,
} from "../src/app-config-disk-probe.js";
import {
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import { isRealpathInsideRoot } from "../src/app-config-sync-path-safety.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
}));

const probePaths = vi.hoisted(() => {
  const tmpRoot = `/tmp/cursor-sync-s18-${Date.now()}`;
  return {
    tmpRoot,
    cursorUser: `${tmpRoot}/cursor-user`,
    dotCursor: `${tmpRoot}/dot-cursor`,
    outside: `${tmpRoot}/outside`,
  };
});

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: probePaths.cursorUser,
    dotCursor: probePaths.dotCursor,
  }),
  getSyncEnumerationConfig: () => ({
    enabledPaths: ["**/*"],
    excludeGlobs: [],
    maxFileSizeKB: 512,
    maxBytes: 512 * 1024,
    cursorUserGlobs: ["**/*"],
    dotCursorGlobs: ["**/*"],
  }),
  isSyncKeyExcludedByConfig: () => false,
  syncKeyToAbsolutePath: (syncKey: string) => {
    if (syncKey.startsWith("cursor-user/")) {
      return path.join(probePaths.cursorUser, syncKey.slice("cursor-user/".length));
    }
    if (syncKey.startsWith("dot-cursor/")) {
      return path.join(probePaths.dotCursor, syncKey.slice("dot-cursor/".length));
    }
    return undefined;
  },
}));

import { decideSyncKey } from "../src/app-storage-sync-decisions.js";
import {
  keepLocalDeclineBlocksDelete,
  pullDeclineBlocksRemote,
} from "../src/app-storage-sync-declines.js";

const mockContext = {} as unknown as vscode.ExtensionContext;
const { tmpRoot, cursorUser, dotCursor, outside } = probePaths;

function emptyScan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
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

describe("staging.18 symlink safety", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("S1: symlinked rules dir does not classify children as proven_absent", async () => {
    const emptyTarget = path.join(dotCursor, "rules-empty");
    await fs.mkdir(emptyTarget, { recursive: true });
    const rulesLink = path.join(dotCursor, "rules");
    await fs.symlink(emptyTarget, rulesLink, "dir");
    const key = "dot-cursor/rules/r8.mdc";
    expect(await classifyLocalPath(mockContext, key)).toBe("skipped_unknown");
    const scan = emptyScan({ provablyAbsentKeys: new Set([key]) });
    applyLocalPathClassificationToScan(scan, key, "skipped_unknown");
    expect(scan.provablyAbsentKeys.has(key)).toBe(false);
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "a",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "t",
      localChecksums: { [key]: "was" },
      remoteChecksums: { [key]: "remote" },
    };
    const classified = classifyAppStorageKeys({}, { [key]: "remote" }, baseline, scan);
    expect(classified.deleteKeys).not.toContain(key);
  });

  it("S3: symlink skills dir pointing outside is skipped_unknown", async () => {
    await fs.writeFile(path.join(outside, "N.md"), "n");
    const skillsLink = path.join(dotCursor, "skills");
    await fs.symlink(outside, skillsLink, "dir");
    const key = "dot-cursor/skills/r8-skill/S3C.md";
    expect(await classifyLocalPath(mockContext, key)).toBe("skipped_unknown");
    const outsideReal = await fs.realpath(outside);
    const rootReal = await fs.realpath(dotCursor);
    expect(isRealpathInsideRoot(outsideReal, rootReal)).toBe(false);
  });
});

describe("staging.18 declines and F6", () => {
  it("F5: pull decline tracks remote checksum", () => {
    expect(
      pullDeclineBlocksRemote({ pullOverwriteRemoteChecksum: "remote-a" }, "remote-a")
    ).toBe(true);
    expect(
      pullDeclineBlocksRemote({ pullOverwriteRemoteChecksum: "remote-a" }, "remote-b")
    ).toBe(false);
  });

  it("F5: keepLocal clears when local checksum changes", () => {
    expect(
      keepLocalDeclineBlocksDelete(
        { keepLocalAgainstRemoteDelete: true, keepLocalAtChecksum: "a" },
        "a"
      )
    ).toBe(true);
    expect(
      keepLocalDeclineBlocksDelete(
        { keepLocalAgainstRemoteDelete: true, keepLocalAtChecksum: "a" },
        "b"
      )
    ).toBe(false);
  });

  it("F6: remote-only baseline key gone everywhere prunes", () => {
    const s = emptyScan({ provablyAbsentKeys: new Set(["dot-cursor/orphan.md"]) });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "a",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "t",
      localChecksums: {},
      remoteChecksums: { "dot-cursor/orphan.md": "was-remote" },
    };
    const d = decideSyncKey({
      syncKey: "dot-cursor/orphan.md",
      scan: s,
      baseline,
      curRemote: undefined,
    });
    expect(d.action).toBe("baseline_refresh");
  });
});
