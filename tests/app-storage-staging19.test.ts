import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { scanLocalAppConfigFiles } from "../src/app-config-local-scan.js";
import {
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";
import {
  assertSafeLocalDeleteTarget,
  writeFileWithoutFollow,
} from "../src/app-config-disk-probe.js";
import { resolveSyncRootsRealpaths } from "../src/app-config-sync-path-safety.js";
import {
  exceedsMassDeleteThreshold,
  getLastEvaluatedMassDeleteBlockDeletions,
  resetSchedulerMassDeleteBlockDedupe,
  shouldRecordSchedulerMassDeleteBlock,
  syncEvaluatedMassDeleteBlockState,
  massDeleteBlockSignature,
} from "../src/app-storage-delete-guard.js";
import { enumerateSyncFiles } from "../src/paths.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
}));

const probePaths = vi.hoisted(() => {
  const tmpRoot = `/tmp/cursor-sync-s19-${Date.now()}`;
  return {
    tmpRoot,
    cursorUser: `${tmpRoot}/cursor-user`,
    dotCursor: `${tmpRoot}/dot-cursor`,
    outside: `${tmpRoot}/outside`,
  };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
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
  };
});

const mockContext = {} as vscode.ExtensionContext;
const { tmpRoot, cursorUser, dotCursor, outside } = probePaths;

const baseline6 = {
  schemaVersion: 1 as const,
  accountKey: "acct",
  destination: "cursor-sync-storage" as const,
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: {
    "cursor-user/a.json": "la",
    "cursor-user/b.json": "lb",
    "cursor-user/c.json": "lc",
    "dot-cursor/d.md": "ld",
    "dot-cursor/e.md": "le",
    "dot-cursor/f.md": "lf",
  },
  remoteChecksums: {
    "cursor-user/a.json": "ra",
    "cursor-user/b.json": "rb",
    "cursor-user/c.json": "rc",
    "dot-cursor/d.md": "rd",
    "dot-cursor/e.md": "re",
    "dot-cursor/f.md": "rf",
  },
};

describe("staging.19 P0 case g — missing sync root with baseline", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.writeFile(path.join(cursorUser, "a.json"), "a");
    await fs.writeFile(path.join(cursorUser, "b.json"), "b");
    await fs.writeFile(path.join(cursorUser, "c.json"), "c");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("g: removed dot-cursor root skips keys and blocks remote deletes (3/6 threshold)", async () => {
    await fs.rm(dotCursor, { recursive: true, force: true });
    const scan = await scanLocalAppConfigFiles(mockContext, baseline6);
    expect(scan.deleteBlockedRootPrefixes.has("dot-cursor/")).toBe(true);
    expect(scan.deletesAllowed).toBe(false);
    for (const key of Object.keys(baseline6.localChecksums)) {
      if (key.startsWith("dot-cursor/")) {
        expect(scan.skippedUnknownKeys.has(key)).toBe(true);
        expect(scan.provablyAbsentKeys.has(key)).toBe(false);
      }
    }
    const classified = classifyAppStorageKeys(
      scan.checksums,
      baseline6.remoteChecksums,
      baseline6,
      scan
    );
    expect(classified.deleteKeys).toEqual([]);
    expect(exceedsMassDeleteThreshold(3, 6)).toBe(true);
  });

  it("g variant: empty dot-cursor root with baseline", async () => {
    await fs.mkdir(dotCursor, { recursive: true });
    const scan = await scanLocalAppConfigFiles(mockContext, baseline6);
    expect(scan.deleteBlockedRootPrefixes.has("dot-cursor/")).toBe(true);
    expect(scan.deletesAllowed).toBe(false);
    expect(scan.skippedUnknownKeys.has("dot-cursor/d.md")).toBe(true);
    const classified = classifyAppStorageKeys(
      scan.checksums,
      baseline6.remoteChecksums,
      baseline6,
      scan
    );
    expect(classified.deleteKeys.filter((k) => k.startsWith("dot-cursor/"))).toEqual(
      []
    );
  });
});

describe("staging.19 FB safe pull write", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(dotCursor, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("does not follow symlink at legacy .tmp or target path", async () => {
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    const target = path.join(dotCursor, "rules", "r.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(outside, "secret.txt"), target);
    await fs.symlink(path.join(outside, "secret.txt"), target + ".tmp");
    const roots = { cursorUser, dotCursor };
    const resolved = await resolveSyncRootsRealpaths(roots);
    await expect(
      writeFileWithoutFollow(target, Buffer.from("new"), {
        syncKey: "dot-cursor/rules/r.md",
        resolved,
      })
    ).rejects.toThrow();
    const secret = await fs.readFile(path.join(outside, "secret.txt"), "utf8");
    expect(secret).toBe("secret");
  });
});

describe("staging.19 FC delete re-check", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(dotCursor, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "victim.txt"), "victim");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("skips delete when folder swapped for symlink before unlink", async () => {
    const victimDir = path.join(dotCursor, "commands", "gone");
    await fs.mkdir(victimDir, { recursive: true });
    const victimFile = path.join(victimDir, "cmd.md");
    await fs.writeFile(victimFile, "x");
    const roots = { cursorUser, dotCursor };
    const resolved = await resolveSyncRootsRealpaths(roots);
    const key = "dot-cursor/commands/gone/cmd.md";
    await assertSafeLocalDeleteTarget(victimFile, key, resolved);
    await fs.rm(victimDir, { recursive: true, force: true });
    await fs.symlink(outside, victimDir, "dir");
    await expect(assertSafeLocalDeleteTarget(victimFile, key, resolved)).rejects.toThrow();
  });
});

describe("staging.19 FD symlinked sync root", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(path.join(outside, "skills", "s"), { recursive: true });
    await fs.writeFile(path.join(outside, "skills", "s", "SKILL.md"), "s");
    await fs.symlink(outside, dotCursor, "dir");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("enumerates files through symlinked dot-cursor root", async () => {
    const files = await enumerateSyncFiles(mockContext, {
      cursorUser,
      dotCursor,
    });
    const keys = files.map((f) => f.relativeSyncKey);
    expect(keys).toContain("dot-cursor/skills/s/SKILL.md");
  });
});

describe("staging.19 FH mass-delete block state", () => {
  it("clears evaluated block set after restore shrinks deletions", () => {
    resetSchedulerMassDeleteBlockDedupe();
    const scan = {
      checksums: {},
      unreadableKeys: new Set<string>(),
      enoentKeys: new Set<string>(),
      provablyAbsentKeys: new Set([
        "dot-cursor/a.md",
        "dot-cursor/b.md",
        "dot-cursor/c.md",
        "dot-cursor/d.md",
      ]),
      skippedUnknownKeys: new Set<string>(),
      untrackedKeys: new Set<string>(),
      absentEligibleKeys: new Set<string>(),
      deletesAllowed: true,
      enumeratedCount: 4,
      rootsHealthy: true,
      trackingScopeMismatch: false,
      deleteBlockedRootPrefixes: new Set<string>(),
    };
    const four = [
      "dot-cursor/a.md",
      "dot-cursor/b.md",
      "dot-cursor/c.md",
      "dot-cursor/d.md",
    ];
    syncEvaluatedMassDeleteBlockState(four, 6, scan);
    expect(getLastEvaluatedMassDeleteBlockDeletions().sort()).toEqual(four.sort());
    const sig1 = massDeleteBlockSignature("push", four, "blocked");
    expect(shouldRecordSchedulerMassDeleteBlock(sig1)).toBe(true);
    expect(shouldRecordSchedulerMassDeleteBlock(sig1)).toBe(false);
    const two = four.slice(0, 2);
    syncEvaluatedMassDeleteBlockState(two, 6, scan);
    expect(getLastEvaluatedMassDeleteBlockDeletions()).toEqual([]);
    const sig2 = massDeleteBlockSignature("push", four, "blocked");
    expect(shouldRecordSchedulerMassDeleteBlock(sig2)).toBe(true);
  });
});
