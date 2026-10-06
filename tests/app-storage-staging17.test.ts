import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
}));

const probePaths = vi.hoisted(() => {
  const tmpRoot = `/tmp/cursor-sync-probe-${Date.now()}`;
  return {
    tmpRoot,
    cursorUser: `${tmpRoot}/cursor-user`,
    dotCursor: `${tmpRoot}/dot-cursor`,
  };
});

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: probePaths.cursorUser,
    dotCursor: probePaths.dotCursor,
  }),
  getSyncEnumerationConfig: () => ({
    enabledPaths: ["**/*"],
    excludeGlobs: ["**/secret/**"],
    maxFileSizeKB: 512,
    maxBytes: 512 * 1024,
    cursorUserGlobs: ["**/*"],
    dotCursorGlobs: ["**/*"],
  }),
  isSyncKeyExcludedByConfig: (syncKey: string, cfg: { excludeGlobs: string[] }) => {
    const rel = syncKey.includes("/") ? syncKey.slice(syncKey.indexOf("/") + 1) : syncKey;
    return cfg.excludeGlobs.some((g) => rel.includes("secret"));
  },
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

import {
  applyLocalPathClassificationToScan,
  classifyLocalPath,
} from "../src/app-config-disk-probe.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";
import {
  appStorageSyncActionFromClassification,
  classifyAppStorageKeys,
} from "../src/app-storage-baseline.js";
import { decideSyncKey } from "../src/app-storage-sync-decisions.js";

const mockContext = {} as vscode.ExtensionContext;
const { tmpRoot, cursorUser, dotCursor } = probePaths;

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

describe("staging.17 disk classifier", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("K26: missing parent dir is proven_absent for nested remote path", async () => {
    const key = "dot-cursor/skills/new-skill/SKILL.md";
    const result = await classifyLocalPath(mockContext, key);
    expect(result).toBe("proven_absent");
  });

  it("K27: strict classifier clears stale provably_absent when unsafe", () => {
    const scan = emptyScan({
      provablyAbsentKeys: new Set(["dot-cursor/skills/old/SKILL.md"]),
    });
    applyLocalPathClassificationToScan(scan, "dot-cursor/skills/old/SKILL.md", "skipped_unknown");
    expect(scan.provablyAbsentKeys.has("dot-cursor/skills/old/SKILL.md")).toBe(false);
    expect(scan.skippedUnknownKeys.has("dot-cursor/skills/old/SKILL.md")).toBe(true);
  });

  it("nested folder delete stays provably_absent after classify", async () => {
    const skillDir = path.join(dotCursor, "skills", "gone");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "x");
    await fs.rm(skillDir, { recursive: true });
    const key = "dot-cursor/skills/gone/SKILL.md";
    expect(await classifyLocalPath(mockContext, key)).toBe("proven_absent");
  });
});

describe("staging.17 declines and per-key sync", () => {
  it("K28: declined pull overwrite is noop for scheduler", () => {
    const s = emptyScan({
      checksums: { "cursor-user/a.md": "local-same" },
    });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: { "cursor-user/a.md": "local-same" },
      remoteChecksums: { "cursor-user/a.md": "remote-old" },
    };
    const decision = decideSyncKey({
      syncKey: "cursor-user/a.md",
      scan: s,
      baseline,
      curLocal: "local-same",
      curRemote: "remote-new",
      declines: { pullOverwriteRemoteChecksum: "remote-new" },
    });
    expect(decision.action).toBe("noop");
  });

  it("K29 t4g/t4h: different keys push and pull, not global conflict", () => {
    const s = emptyScan({
      checksums: {
        "cursor-user/x.md": "local-x-new",
        "cursor-user/y.md": "local-y",
      },
    });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: {
        "cursor-user/x.md": "local-x-old",
        "cursor-user/y.md": "local-y",
      },
      remoteChecksums: {
        "cursor-user/x.md": "remote-x",
        "cursor-user/y.md": "remote-y-old",
      },
    };
    const remote = {
      "cursor-user/x.md": "remote-x",
      "cursor-user/y.md": "remote-y-new",
    };
    const classified = classifyAppStorageKeys(
      {
        "cursor-user/x.md": "local-x-new",
        "cursor-user/y.md": "local-y",
      },
      remote,
      baseline,
      s
    );
    expect(classified.pushKeys).toContain("cursor-user/x.md");
    expect(classified.pullKeys).toContain("cursor-user/y.md");
    expect(classified.conflictKeys).toEqual([]);
    const action = appStorageSyncActionFromClassification(classified, remote);
    expect(action.action).toBe("pull-push");
  });

  it("K25: excluded tracked key prunes without blocking other push", () => {
    const s = emptyScan({
      untrackedKeys: new Set(["dot-cursor/secret/moved.md"]),
      checksums: { "cursor-user/ok.md": "local-ok" },
    });
    const baseline = {
      schemaVersion: 1 as const,
      accountKey: "acct",
      destination: "cursor-sync-storage" as const,
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: {
        "dot-cursor/secret/moved.md": "was-local",
        "cursor-user/ok.md": "was-ok",
      },
      remoteChecksums: {
        "dot-cursor/secret/moved.md": "remote-secret",
        "cursor-user/ok.md": "remote-ok",
      },
    };
    const classified = classifyAppStorageKeys(
      { "cursor-user/ok.md": "local-ok-new" },
      {
        "dot-cursor/secret/moved.md": "remote-secret",
        "cursor-user/ok.md": "remote-ok",
      },
      baseline,
      s
    );
    expect(classified.baselineRefreshKeys).toContain("dot-cursor/secret/moved.md");
    expect(classified.pushKeys).toContain("cursor-user/ok.md");
    expect(classified.conflictKeys).not.toContain("dot-cursor/secret/moved.md");
  });
});
