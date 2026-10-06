import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  remoteChecksumChangedSinceBaseline,
  shouldPullAppConfigFile,
  type AppStorageBaseline,
} from "../src/app-storage-baseline.js";
import { pullOverwriteShouldBePreselected } from "../src/app-storage-sync-decisions.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";

const baseline: AppStorageBaseline = {
  schemaVersion: 1,
  accountKey: "acct",
  destination: "cursor-sync-storage",
  remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
  localChecksums: { "dot-cursor/a.md": "baseline-local" },
  remoteChecksums: { "dot-cursor/a.md": "remote-a" },
};

function emptyScan(): LocalConfigFileScan {
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
  };
}

describe("staging.34 P0 local edit vs unchanged remote", () => {
  it("still detects local drift when remote matches baseline", () => {
    expect(remoteChecksumChangedSinceBaseline("dot-cursor/a.md", "remote-a", baseline)).toBe(
      false
    );
    expect(shouldPullAppConfigFile("edited-local", "remote-a")).toBe(true);
  });

  it("does not preselect overwrite when local diverged but remote is unchanged", () => {
    const picked = pullOverwriteShouldBePreselected(
      "dot-cursor/a.md",
      baseline,
      "edited-local",
      emptyScan(),
      "remote-a"
    );
    expect(picked).toBe(false);
  });
});

describe("staging.34 held routing", () => {
  const clearHeldMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
  const executePullMock = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ status: "held" as const })
  );

  vi.mock("vscode", () => import("./__mocks__/vscode.js"));
  vi.mock("../src/app-auth.js", () => ({
    getAppSession: vi.fn().mockResolvedValue("jwt"),
  }));
  vi.mock("../src/app-configs.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/app-configs.js")>();
    return {
      ...actual,
      clearScheduledRootHeldMarkers: clearHeldMock,
      determineAppStorageSyncAction: vi.fn().mockResolvedValue({ action: "pull", keys: ["k"] }),
    };
  });
  vi.mock("../src/pull.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/pull.js")>();
    return { ...actual, executePull: executePullMock };
  });
  vi.mock("../src/sync-operation.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/sync-operation.js")>();
    return { ...actual, isSyncOperationActive: () => false };
  });
  vi.mock("../src/diagnostics.js", () => ({
    getLogger: () => ({ appendLine: vi.fn() }),
    loadSyncState: vi.fn().mockResolvedValue(undefined),
  }));
  vi.mock("../src/analytics.js", () => ({ sendEvent: vi.fn() }));

  beforeEach(() => {
    vi.resetModules();
    clearHeldMock.mockClear();
    executePullMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scheduled pull held does not clear root-held markers", async () => {
    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(executePullMock).toHaveBeenCalled();
    expect(clearHeldMock).not.toHaveBeenCalled();
  });
});
