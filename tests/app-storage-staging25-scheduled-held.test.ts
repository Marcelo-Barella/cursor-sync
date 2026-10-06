import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const addSyncHistoryEntryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const showWarningMessageMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => defaultValue,
    }),
  },
  window: {
    showWarningMessage: showWarningMessageMock,
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn(), show: vi.fn() }),
  addSyncHistoryEntry: addSyncHistoryEntryMock,
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn().mockResolvedValue("jwt"),
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: vi.fn().mockResolvedValue({ prefix: "users/u/" }),
  getR2Object: vi.fn(),
}));

vi.mock("../src/app-storage-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-storage-baseline.js")>();
  return {
    ...actual,
    loadAppStorageBaseline: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      localChecksums: { "dot-cursor/a.md": "x" },
      remoteChecksums: { "dot-cursor/a.md": "x" },
    }),
    updateAppStorageBaselineAfterSync: vi.fn().mockResolvedValue(undefined),
    baselineHasEntries: () => true,
  };
});

vi.mock("../src/app-session-identity.js", () => ({
  appStorageAccountKey: () => "acct",
}));

const blockedScan = {
  checksums: {},
  unreadableKeys: new Set(["dot-cursor/a.md"]),
  excludedKeys: new Set(),
  oversizeKeys: new Set(),
  symlinkKeys: new Set(),
  enoentKeys: new Set(),
  provablyAbsentKeys: new Set(),
  skippedUnknownKeys: new Set(["dot-cursor/a.md"]),
  untrackedKeys: new Set(),
  absentEligibleKeys: new Set(),
  deletesAllowed: false,
  enumeratedCount: 0,
  rootsHealthy: false,
  trackingScopeMismatch: false,
  deleteBlockedRootPrefixes: new Set(["dot-cursor/"]),
};

vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return {
    ...actual,
    scanLocalAppConfigFiles: vi.fn().mockResolvedValue(blockedScan),
    buildTrackingScopeForBaseline: () => ({
      enabledPaths: [],
      excludeGlobs: [],
      maxFileSizeKB: 512,
    }),
  };
});

vi.mock("../src/app-config-disk-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-disk-probe.js")>();
  return {
    ...actual,
    scanWithDiskProbes: async (_c: unknown, scan: typeof blockedScan) => scan,
  };
});

vi.mock("../src/paths.js", async () => {
  const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
  return {
    ...PATHS_MOCK_USER_LABELS,
    resolveSyncRoots: () => ({
      cursorUser: "/tmp/cu",
      dotCursor: "/tmp/dc",
    }),
    syncKeyToAbsolutePath: () => "/tmp/dc/a.md",
  };
});

function makeContext(): vscode.ExtensionContext {
  const store: Record<string, unknown> = {};
  return {
    globalState: {
      get: (k: string) => store[k],
      update: async (k: string, v: unknown) => {
        store[k] = v;
      },
    },
    secrets: { get: async () => undefined, store: async () => {} },
  } as unknown as vscode.ExtensionContext;
}

describe("M6 scheduled pull root held", () => {
  beforeEach(async () => {
    vi.resetModules();
    addSyncHistoryEntryMock.mockClear();
    showWarningMessageMock.mockClear();
    const { mockFetchJsonResponse } = await import("./mock-fetch-json.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchJsonResponse({
          payload: {
            schemaVersion: 1,
            manifest: {
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: "2026-01-01T00:00:00.000Z",
              sourceMachineId: "m",
              sourceOS: "linux",
              files: {
                "dot-cursor/a.md": { checksum: "remote", sizeBytes: 1 },
              },
            },
            files: {
              "dot-cursor/a.md": { checksum: "remote", sizeBytes: 1, content: "hi" },
            },
          },
          updated_at: "2026-01-02T00:00:00.000Z",
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays silent and records held history once, not failed partial pull", async () => {
    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const ctx = makeContext();
    const ok1 = await executePullAppConfigs(ctx, { trigger: "scheduled" });
    const ok2 = await executePullAppConfigs(ctx, { trigger: "scheduled" });
    const ok3 = await executePullAppConfigs(ctx, { trigger: "scheduled" });
    expect(ok1).toBe("held");
    expect(ok2).toBe("held");
    expect(ok3).toBe("held");
    expect(showWarningMessageMock).toHaveBeenCalledTimes(1);
    const heldEntries = addSyncHistoryEntryMock.mock.calls.filter((c) =>
      String(c[1]?.error ?? "").startsWith("held:")
    );
    expect(heldEntries.length).toBe(1);
    expect(heldEntries[0]?.[1]?.success).toBe(false);
    expect(heldEntries[0]?.[1]?.held).toBe(true);
    const failed = addSyncHistoryEntryMock.mock.calls.filter(
      (c) => c[1]?.success === false && !c[1]?.held
    );
    expect(failed.length).toBe(0);
  });
});
