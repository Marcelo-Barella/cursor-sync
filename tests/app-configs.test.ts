import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const appendLineMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showQuickPickMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === "appApiUrl") {
          return "http://localhost:8100" as T;
        }
        if (key === "syncProfileName") {
          return "default" as T;
        }
        if (key === "safeMode") {
          return false as T;
        }
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: vi.fn(),
    showQuickPick: showQuickPickMock,
  },
}));

const addSyncHistoryEntryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
  }),
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
  enumerateSyncFiles: async () => [
    {
      absolutePath: "/tmp/cursor-user/settings.json",
      relativeSyncKey: "cursor-user/settings.json",
    },
  ],
  getSyncEnumerationConfig: () => ({
    enabledPaths: ["settings.json"],
    excludeGlobs: [],
    maxFileSizeKB: 512,
    maxBytes: 512 * 1024,
    cursorUserGlobs: ["settings.json"],
    dotCursorGlobs: [],
  }),
  isSyncKeyExcludedByConfig: () => false,
  syncKeyToAbsolutePath: (syncKey: string) => {
    if (syncKey === "cursor-user/settings.json") {
      return "/tmp/cursor-user/settings.json";
    }
    return undefined;
  },
};
});

vi.mock("../src/packaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging.js")>();
  return {
  ...actual,
  packageFiles: async () => ({
    skipped: [],
    packaged: new Map([
      [
        "cursor-user/settings.json",
        {
          content: '{"x":1}',
          checksum: "abc",
          sizeBytes: 7,
        },
      ],
    ]),
    manifest: {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMachineId: "machine",
      sourceOS: "linux",
      files: {
        "cursor-user/settings.json": {
          checksum: "abc",
          sizeBytes: 7,
        },
      },
    },
  }),
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [], failedPaths: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

const scanLocalAppConfigFilesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    checksums: {},
    unreadableKeys: new Set(),
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(),
    untrackedKeys: new Set(),
    absentEligibleKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 1,
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
    assertSafePullTarget: vi.fn().mockResolvedValue(undefined),
    ensureSyncRootsForFreshPull: vi.fn().mockResolvedValue([]),
    resolveSyncRootsRealpaths: vi.fn().mockImplementation(
      async (roots: { cursorUser: string; dotCursor: string }) => ({
        cursorUser: { rootPath: roots.cursorUser, rootReal: roots.cursorUser },
        dotCursor: { rootPath: roots.dotCursor, rootReal: roots.dotCursor },
      })
    ),
    scanWithDiskProbes: async (
      _ctx: unknown,
      scan: import("../src/app-config-local-scan.js").LocalConfigFileScan,
      keys: Iterable<string>
    ) => {
      const next = {
        ...scan,
        absentEligibleKeys: new Set(scan.absentEligibleKeys),
        provablyAbsentKeys: new Set(scan.provablyAbsentKeys),
      };
      for (const key of keys) {
        if (key === "cursor-user/settings.json" && !next.checksums[key]) {
          next.absentEligibleKeys.add(key);
          next.provablyAbsentKeys.add(key);
        }
      }
      return next;
    },
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  rename: vi.fn().mockResolvedValue(undefined),
}));

const getAppSessionMock = vi.hoisted(() => vi.fn());
const getR2StorageCredentialsMock = vi.hoisted(() => vi.fn());
const putR2ObjectMock = vi.hoisted(() => vi.fn());
const getR2ObjectMock = vi.hoisted(() => vi.fn());
const deleteR2ObjectMock = vi.hoisted(() => vi.fn());
const putEncryptedR2ObjectMock = vi.hoisted(() => vi.fn());
const getEncryptedR2ObjectMock = vi.hoisted(() => vi.fn());
const putConfigsManifestWithRetryMock = vi.hoisted(() => vi.fn());
const fetchConfigsApiMock = vi.hoisted(() => vi.fn());
const decryptManifestPayloadMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: getR2StorageCredentialsMock,
  putR2Object: putR2ObjectMock,
  getR2Object: getR2ObjectMock,
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
  getEncryptedR2Object: getEncryptedR2ObjectMock,
}));

vi.mock("../src/e2e/storage-plaintext.js", () => ({
  deletePlaintextR2Objects: vi.fn().mockResolvedValue({
    settled: [],
    failed: [],
    partial: false,
    results: [],
  }),
  listPlaintextObjectKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/e2e/configs-sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/configs-sync.js")>();
  return {
    ...actual,
    fetchConfigsApi: fetchConfigsApiMock,
    putConfigsManifestWithRetry: putConfigsManifestWithRetryMock,
    decryptManifestPayload: decryptManifestPayloadMock,
  };
});

vi.mock("../src/e2e/app-storage-cleanup.js", () => ({
  runAppStorageLegacyCleanup: vi.fn().mockResolvedValue({ kind: "skipped" }),
}));

vi.mock("../src/e2e/migration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/migration.js")>();
  return {
    ...actual,
    loadMigrationState: vi.fn().mockResolvedValue(undefined),
    saveMigrationState: vi.fn().mockResolvedValue(undefined),
    tryCompleteMigration: vi.fn().mockResolvedValue(undefined),
  };
});

function makeContext(): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-app-configs-test" },
    globalState: {
      get: () => undefined,
      update: async () => {},
    },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
  } as unknown as vscode.ExtensionContext;
}

describe("app-configs API", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockReset();
    addSyncHistoryEntryMock.mockReset();
    showErrorMessageMock.mockReset();
    showInformationMessageMock.mockReset();
    showQuickPickMock.mockReset();
    getAppSessionMock.mockReset();
    getR2StorageCredentialsMock.mockReset();
    putR2ObjectMock.mockReset();
    getR2ObjectMock.mockReset();
    getR2StorageCredentialsMock.mockResolvedValue({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "sync-bucket",
      region: "auto",
      prefix: "users/user-1/",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    putR2ObjectMock.mockResolvedValue(undefined);
    getR2ObjectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires app session for fetchAppConfigs", async () => {
    getAppSessionMock.mockResolvedValue(undefined);
    const { fetchAppConfigs } = await import("../src/app-configs.js");

    const result = await fetchAppConfigs(makeContext());

    expect(result).toBeUndefined();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Log in to Cursor Sync to sync with Cursor Sync storage."
    );
  });

  it("GET /configs with Bearer token", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const { mockFetchJsonResponse } = await import("./mock-fetch-json.js");
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchJsonResponse({
        payload: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchAppConfigs } = await import("../src/app-configs.js");
    const result = await fetchAppConfigs(makeContext());

    expect(result?.updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8100/configs",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-token",
        }),
      })
    );
  });

  it("PUT /configs with payload body", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const { mockFetchJsonResponse } = await import("./mock-fetch-json.js");
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchJsonResponse({
        payload: { schemaVersion: 1, manifest: { files: {} }, files: {} },
        updated_at: "2026-01-02T00:00:00.000Z",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { putAppConfigs } = await import("../src/app-configs.js");
    const payload = {
      schemaVersion: 1 as const,
      manifest: {
        schemaVersion: 1 as const,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux" as const,
        files: {},
      },
      files: {},
    };

    await putAppConfigs(makeContext(), payload);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8100/configs",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ payload }),
      })
    );
  });

  it("returns login message on 401", async () => {
    getAppSessionMock.mockResolvedValue("expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      })
    );

    const { fetchAppConfigs } = await import("../src/app-configs.js");
    const result = await fetchAppConfigs(makeContext());

    expect(result).toBeUndefined();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("Log in to Cursor Sync to sync with Cursor Sync storage.")
    );
  });
});

describe("hasAppSession", () => {
  beforeEach(() => {
    vi.resetModules();
    getAppSessionMock.mockReset();
  });

  it("returns true when getAppSession has a token", async () => {
    getAppSessionMock.mockResolvedValue("jwt");
    const { hasAppSession } = await import("../src/app-configs.js");
    expect(await hasAppSession(makeContext())).toBe(true);
  });

  it("returns false when getAppSession is empty", async () => {
    getAppSessionMock.mockResolvedValue(undefined);
    const { hasAppSession } = await import("../src/app-configs.js");
    expect(await hasAppSession(makeContext())).toBe(false);
  });
});

describe("app-configs R2 sync", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockReset();
    addSyncHistoryEntryMock.mockReset();
    showErrorMessageMock.mockReset();
    showInformationMessageMock.mockReset();
    showQuickPickMock.mockReset();
    getAppSessionMock.mockReset();
    getR2StorageCredentialsMock.mockReset();
    putR2ObjectMock.mockReset();
    getR2ObjectMock.mockReset();
    deleteR2ObjectMock.mockReset();
    deleteR2ObjectMock.mockResolvedValue(204);
    putEncryptedR2ObjectMock.mockReset().mockResolvedValue(undefined);
    getEncryptedR2ObjectMock.mockReset().mockResolvedValue(undefined);
    putConfigsManifestWithRetryMock.mockReset().mockResolvedValue({
      manifestVersion: 1,
      manifestCiphertext: "c2VFMQ==",
      payload: null,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    fetchConfigsApiMock.mockReset().mockResolvedValue({
      manifestVersion: 0,
      manifestCiphertext: null,
      payload: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    decryptManifestPayloadMock.mockReset();
    getR2StorageCredentialsMock.mockResolvedValue({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "sync-bucket",
      region: "auto",
      prefix: "users/user-1/",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    putR2ObjectMock.mockResolvedValue(200);
    getR2ObjectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when pushAppConfigs cannot mint storage credentials", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    getR2StorageCredentialsMock.mockResolvedValue(undefined);
    const { executePushAppConfigs } = await import("../src/app-configs.js");

    const ok = await executePushAppConfigs(makeContext());

    expect(ok).toBe(false);
    expect(putEncryptedR2ObjectMock).not.toHaveBeenCalled();
  });

  it("push uploads encrypted bytes to R2 and PUTs manifestCiphertext", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext());

    expect(ok).toBe(true);
    expect(putEncryptedR2ObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "users/user-1/" }),
      expect.any(Buffer),
      "user-1",
      1,
      "cursor-user/settings.json",
      Buffer.from('{"x":1}')
    );
    expect(putConfigsManifestWithRetryMock).toHaveBeenCalled();
    expect(appendLineMock).toHaveBeenCalledWith(
      expect.stringContaining("Uploaded cursor-user/settings.json")
    );
  });

  it("fails when R2 upload errors and reports zero successful uploads", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    putEncryptedR2ObjectMock.mockRejectedValue(new Error("403 forbidden"));

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext());

    expect(ok).toBe(false);
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/Cursor Sync storage.*no files uploaded/i)
    );
    expect(addSyncHistoryEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false, fileCount: 0, destination: "cursor-sync-storage" })
    );
  });

  it("pull reads encrypted manifest and R2 object bytes", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    showQuickPickMock.mockImplementation(async (items: { label: string; picked?: boolean }[]) =>
      items.map((item) => ({ ...item, picked: item.picked ?? true }))
    );
    const remoteBody = Buffer.from('{"from":"r2"}');
    const { computeChecksum } = await import("../src/packaging.js");
    const remoteChecksum = computeChecksum(remoteBody);
    fetchConfigsApiMock.mockResolvedValue({
      manifestVersion: 1,
      manifestCiphertext: Buffer.alloc(36, 0).toString("base64"),
      payload: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    decryptManifestPayloadMock.mockReturnValue({
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        files: {
          "cursor-user/settings.json": {
            checksum: remoteChecksum,
            sizeBytes: remoteBody.length,
          },
        },
      },
      files: {
        "cursor-user/settings.json": {
          checksum: remoteChecksum,
          sizeBytes: remoteBody.length,
        },
      },
    });
    getEncryptedR2ObjectMock.mockResolvedValue(remoteBody);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("settings.json")) {
        return Buffer.from('{"old":true}');
      }
      throw new Error("ENOENT");
    });

    const diskProbe = await import("../src/app-config-disk-probe.js");
    const writeSpy = vi
      .spyOn(diskProbe, "writeFileWithoutFollow")
      .mockResolvedValue(undefined);
    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const baseline = await import("../src/app-storage-baseline.js");
    vi.spyOn(baseline, "updateAppStorageBaselineAfterSync").mockResolvedValue(undefined);
    const status = await executePullAppConfigs(makeContext());

    expect(status).toBe("success");
    expect(getEncryptedR2ObjectMock).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });
});
