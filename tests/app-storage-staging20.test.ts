import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { classifyLocalPath } from "../src/app-config-disk-probe.js";
import {
  isLocallyAbsentSafeToPull,
  decideSyncKey,
} from "../src/app-storage-sync-decisions.js";
import { scanLocalAppConfigFiles } from "../src/app-config-local-scan.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
}));

const probePaths = vi.hoisted(() => {
  const tmpRoot = `/tmp/cursor-sync-s20-${Date.now()}`;
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

describe("staging.20 fresh device missing ~/.cursor", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("classifies remote-only keys as proven_absent without baseline", async () => {
    const key = "dot-cursor/rules/r.mdc";
    expect(
      await classifyLocalPath(mockContext, key, undefined, { baselineLocalKeys: [] })
    ).toBe("proven_absent");
    const scan = emptyScan({
      absentEligibleKeys: new Set([key]),
      provablyAbsentKeys: new Set([key]),
    });
    expect(isLocallyAbsentSafeToPull(key, scan)).toBe(true);
    const decision = decideSyncKey({
      syncKey: key,
      scan,
      baseline: undefined,
      curRemote: "remote",
    });
    expect(decision.action).toBe("pull");
  });
});

describe("staging.20 symlinked empty ~/.cursor fresh device", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, dotCursor, "dir");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("allows pull for keys directly under symlinked root", async () => {
    const key = "dot-cursor/rules/r.mdc";
    expect(
      await classifyLocalPath(mockContext, key, undefined, { baselineLocalKeys: [] })
    ).toBe("proven_absent");
  });
});

