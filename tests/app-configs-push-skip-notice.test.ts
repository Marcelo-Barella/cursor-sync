import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const showInformationMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === "safeMode") return false as T;
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn(), show: vi.fn() }),
  addSyncHistoryEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/extensions.js", () => ({
  generateExtensionsJson: () => "[]",
}));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: "/tmp/cursor-user",
    dotCursor: "/tmp/dot-cursor",
  }),
  enumerateSyncFiles: async () => [
    {
      absolutePath: "/tmp/cursor-user/settings.json",
      relativeSyncKey: "cursor-user/settings.json",
    },
    {
      absolutePath: "/tmp/dot-cursor/link.md",
      relativeSyncKey: "dot-cursor/link.md",
    },
  ],
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
    if (syncKey === "cursor-user/settings.json") {
      return "/tmp/cursor-user/settings.json";
    }
    if (syncKey === "dot-cursor/link.md") {
      return "/tmp/dot-cursor/link.md";
    }
    return undefined;
  },
}));

vi.mock("../src/packaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging.js")>();
  return {
    ...actual,
    packageFiles: async () => ({
      skipped: [{ relativeSyncKey: "dot-cursor/link.md", reason: "symlink" }],
      packaged: new Map([
        [
          "cursor-user/settings.json",
          { content: '{"x":1}', checksum: "a", sizeBytes: 7 },
        ],
        [
          "dot-cursor/link.md",
          { content: "skip", checksum: "b", sizeBytes: 4 },
        ],
      ]),
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        files: {
          "cursor-user/settings.json": { checksum: "a", sizeBytes: 7 },
          "dot-cursor/link.md": { checksum: "b", sizeBytes: 4 },
        },
      },
    }),
  };
});

const scanLocalAppConfigFilesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    checksums: { "cursor-user/settings.json": "a" },
    unreadableKeys: new Set(),
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(["dot-cursor/link.md"]),
    untrackedKeys: new Set(),
    absentEligibleKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 2,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
  })
);

vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return {
    ...actual,
    scanLocalAppConfigFiles: scanLocalAppConfigFilesMock,
  };
});

vi.mock("../src/app-config-disk-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-disk-probe.js")>();
  return {
    ...actual,
    scanWithDiskProbes: async (_c: unknown, scan: typeof scanLocalAppConfigFilesMock) =>
      scan,
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  rename: vi.fn().mockResolvedValue(undefined),
}));

const getAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue("jwt"));
const putR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(200));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/app-storage-sync-declines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-storage-sync-declines.js")>();
  return {
    ...actual,
    pruneResolvedDeclines: vi.fn().mockResolvedValue(undefined),
    filterPushKeysRespectingDeclines: async (
      _c: unknown,
      keys: string[]
    ) => keys,
    loadSyncDeclineStore: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("../src/app-storage-baseline.js", () => ({
  loadAppStorageBaseline: vi.fn().mockResolvedValue(undefined),
  updateAppStorageBaselineAfterSync: vi.fn().mockResolvedValue(undefined),
  baselineHasEntries: () => false,
}));

vi.mock("../src/app-session-identity.js", () => ({
  appStorageAccountKey: () => "acct",
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: vi.fn().mockResolvedValue({ prefix: "users/u/" }),
  putR2Object: putR2ObjectMock,
  getR2Object: vi.fn(),
  deleteR2Object: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
  return {
    extensionUri: { fsPath: "/ext" },
    globalState: { get: vi.fn(), update: vi.fn() },
    secrets: { get: vi.fn(), store: vi.fn() },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("manual push skip notice (F3)", () => {
  beforeEach(() => {
    vi.resetModules();
    showInformationMessageMock.mockReset();
    putR2ObjectMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          payload: { schemaVersion: 1, manifest: { files: {} }, files: {} },
          updated_at: "2026-01-02T00:00:00.000Z",
        }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Pushed N, skipped M after manual executePushAppConfigs", async () => {
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext(), { trigger: "manual" });
    if (!ok) {
      throw new Error(
        `push failed: ${showErrorMessageMock.mock.calls.map((c) => c[0]).join(" | ")}`
      );
    }
    expect(ok).toBe(true);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("Pushed 1 file(s), skipped 1")
      )
    ).toBe(true);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("dot-cursor/link.md")
      )
    ).toBe(true);
  });
});
