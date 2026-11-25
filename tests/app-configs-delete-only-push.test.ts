import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const appendLineMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showQuickPickMock = vi.fn();
const addSyncHistoryEntryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vscode")>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue?: T) => {
          if (key === "safeMode") {
            return false as T;
          }
          return defaultValue;
        },
      }),
    },
    window: {
      ...actual.window,
      showErrorMessage: showErrorMessageMock,
      showInformationMessage: showInformationMessageMock,
      showQuickPick: showQuickPickMock,
    },
  };
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: appendLineMock, show: vi.fn() }),
  addSyncHistoryEntry: addSyncHistoryEntryMock,
}));

vi.mock("../src/extensions.js", () => ({
  generateExtensionsJson: () => "[]",
}));

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
  return {
  ...actual,
  ...PATHS_MOCK_USER_LABELS,
  listSymlinkSyncKeysUnderRoots: async () => [],
  resolveSyncRoots: () => ({
    cursorUser: "/tmp/cursor-user",
    dotCursor: "/tmp/dot-cursor",
  }),
  enumerateSyncFiles: async () => [],
  getSyncEnumerationConfig: () => ({
    enabledPaths: [],
    excludeGlobs: [],
    maxFileSizeKB: 512,
    maxBytes: 512 * 1024,
    cursorUserGlobs: [],
    dotCursorGlobs: [],
  }),
  isSyncKeyExcludedByConfig: () => false,
  syncKeyToAbsolutePath: () => undefined,
};
});

vi.mock("../src/packaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging.js")>();
  return {
    ...actual,
    packageFiles: async () => ({
      skipped: [],
      packaged: new Map(),
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        files: {},
      },
    }),
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [], failedPaths: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

vi.mock("../src/app-config-disk-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-disk-probe.js")>();
  return {
    ...actual,
    scanWithDiskProbes: async (_c: unknown, scan: { provablyAbsentKeys: Set<string> }) =>
      scan,
  };
});

vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return {
    ...actual,
    scanLocalAppConfigFiles: vi.fn().mockResolvedValue({
      checksums: {},
      unreadableKeys: new Set(),
      excludedKeys: new Set(),
      oversizeKeys: new Set(),
      symlinkKeys: new Set(),
      enoentKeys: new Set(),
      provablyAbsentKeys: new Set(["dot-cursor/removed.md"]),
      skippedUnknownKeys: new Set(),
      untrackedKeys: new Set(),
      absentEligibleKeys: new Set(),
      deletesAllowed: true,
      enumeratedCount: 0,
      rootsHealthy: true,
      trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    }),
  };
});

const getAppSessionMock = vi.hoisted(() => vi.fn());
const getR2StorageCredentialsMock = vi.hoisted(() => vi.fn());
const putR2ObjectMock = vi.hoisted(() => vi.fn());
const deleteR2ObjectMock = vi.hoisted(() => vi.fn());
const putEncryptedR2ObjectMock = vi.hoisted(() => vi.fn());
const putConfigsManifestWithRetryMock = vi.hoisted(() => vi.fn());
const fetchConfigsApiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: getR2StorageCredentialsMock,
  putR2Object: putR2ObjectMock,
  getR2Object: vi.fn(),
  deleteR2Object: deleteR2ObjectMock,
}));

vi.mock("../src/e2e/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/gate.js")>();
  return {
    ...actual,
    requireE2eUnlocked: vi.fn().mockResolvedValue({
      ok: true,
      kind: "dek",
      userId: "user-1",
      keyVersion: 1,
      dek: Buffer.alloc(32, 2),
    }),
  };
});

vi.mock("../src/e2e/r2-storage.js", () => ({
  putEncryptedR2Object: putEncryptedR2ObjectMock,
  getEncryptedR2Object: vi.fn(),
}));

vi.mock("../src/e2e/configs-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/configs-sync.js")>();
  return {
    ...actual,
    fetchConfigsApi: fetchConfigsApiMock,
    putConfigsManifestWithRetry: putConfigsManifestWithRetryMock,
  };
});

vi.mock("../src/e2e/migration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/migration.js")>();
  return {
    ...actual,
    loadMigrationState: vi.fn().mockResolvedValue(undefined),
    saveMigrationState: vi.fn().mockResolvedValue(undefined),
    tryCompleteMigration: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/e2e/app-storage-cleanup.js", () => ({
  runAppStorageLegacyCleanup: vi.fn().mockResolvedValue({ kind: "skipped" }),
}));

vi.mock("../src/e2e/legacy-cleanup.js", () => ({
  legacyPlaintextKeysFromConfigsResponse: vi.fn().mockReturnValue([]),
}));

function makeContext(): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-delete-only" },
    globalState: { get: () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  } as unknown as vscode.ExtensionContext;
}

describe("delete-only push", () => {
  beforeEach(async () => {
    vi.resetModules();
    getAppSessionMock.mockResolvedValue("jwt");
    getR2StorageCredentialsMock.mockResolvedValue({
      prefix: "users/u/",
      endpoint: "https://r2.example",
      bucket: "b",
      region: "auto",
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    deleteR2ObjectMock.mockResolvedValue(204);
    putR2ObjectMock.mockResolvedValue(200);
    putEncryptedR2ObjectMock.mockReset().mockResolvedValue(undefined);
    putConfigsManifestWithRetryMock.mockReset().mockResolvedValue({
      manifestVersion: 1,
      manifestCiphertext: "c2VFMQ==",
      payload: null,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    const remotePayload = {
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "m",
        sourceOS: "linux",
        files: {
          "dot-cursor/removed.md": { checksum: "was", sizeBytes: 1 },
        },
      },
      files: {
        "dot-cursor/removed.md": {
          checksum: "was",
          sizeBytes: 1,
          content: "x",
        },
      },
    };
    fetchConfigsApiMock.mockReset().mockResolvedValue({
      manifestVersion: 0,
      manifestCiphertext: null,
      payload: remotePayload,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
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
                "dot-cursor/removed.md": { checksum: "was", sizeBytes: 1 },
              },
            },
            files: {
              "dot-cursor/removed.md": {
                checksum: "was",
                sizeBytes: 1,
                content: "x",
              },
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

  it("scheduled push re-checks provably-absent for explicit deletions (M17)", async () => {
    const { scanLocalAppConfigFiles } = await import("../src/app-config-local-scan.js");
    vi.mocked(scanLocalAppConfigFiles).mockResolvedValueOnce({
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
    });
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext(), {
      keys: [],
      deletions: ["dot-cursor/removed.md"],
      trigger: "scheduled",
    });
    expect(deleteR2ObjectMock).not.toHaveBeenCalled();
    expect(ok).toBeDefined();
  });

  it("XDEL: recreated file after confirm ends with info, not failed push", async () => {
    const { scanLocalAppConfigFiles } = await import("../src/app-config-local-scan.js");
    vi.mocked(scanLocalAppConfigFiles).mockResolvedValueOnce({
      checksums: { "dot-cursor/removed.md": "newlocal" },
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
    });
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext(), {
      keys: [],
      deletions: ["dot-cursor/removed.md"],
      trigger: "syncNow",
    });
    expect(ok).toBe(true);
    expect(deleteR2ObjectMock).not.toHaveBeenCalled();
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/recreated locally/i)
    );
    const failedHistory = addSyncHistoryEntryMock.mock.calls.find(
      (c) => c[1]?.success === false
    );
    expect(failedHistory).toBeUndefined();
  });

  it("deletes remote object and updates manifest without uploads", async () => {
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext(), {
      keys: [],
      deletions: ["dot-cursor/removed.md"],
      trigger: "syncNow",
    });
    expect(ok).toBe(true);
    expect(deleteR2ObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "users/u/" }),
      "dot-cursor/removed.md"
    );
    expect(putR2ObjectMock).not.toHaveBeenCalled();
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/removed 1/i)
    );
  });
});
