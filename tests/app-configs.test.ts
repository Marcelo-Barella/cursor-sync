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
  const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
  return {
  ...PATHS_MOCK_USER_LABELS,
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payload: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payload: { schemaVersion: 1, manifest: { files: {} }, files: {} },
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
    });
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
    expect(putR2ObjectMock).not.toHaveBeenCalled();
  });

  it("push uploads bytes to R2 and PUTs metadata-only payload", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payload: { schemaVersion: 1, manifest: { files: {} }, files: {} },
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext());

    expect(ok).toBe(true);
    expect(putR2ObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "users/user-1/" }),
      "cursor-user/settings.json",
      Buffer.from('{"x":1}')
    );
    const putCall = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "PUT"
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall![1].body as string);
    expect(body.payload.files["cursor-user/settings.json"]).toEqual({
      checksum: "abc",
      sizeBytes: 7,
    });
    expect(body.payload.files["cursor-user/settings.json"].content).toBeUndefined();
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      "Pushed 1 file(s) to Cursor Sync storage"
    );
    expect(appendLineMock).toHaveBeenCalledWith(
      expect.stringContaining("Uploaded cursor-user/settings.json")
    );
  });

  it("fails when R2 upload errors and reports zero successful uploads", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    putR2ObjectMock.mockRejectedValue(new Error("403 forbidden"));
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

  it("pull prefers R2 bytes and falls back to legacy payload content", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    getR2StorageCredentialsMock.mockResolvedValue({ token: "r2" });
    getR2ObjectMock.mockResolvedValue(undefined);
    showQuickPickMock.mockImplementation(async (items: { label: string }[]) => items);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payload: {
          schemaVersion: 1,
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
          files: {
            "cursor-user/settings.json": {
              content: '{"legacy":true}',
              checksum: "abc",
              sizeBytes: 7,
            },
          },
        },
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith("settings.json")) {
        return Buffer.from('{"old":true}');
      }
      throw new Error("ENOENT");
    });

    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const baseline = await import("../src/app-storage-baseline.js");
    vi.spyOn(baseline, "updateAppStorageBaselineAfterSync").mockResolvedValue(undefined);
    await executePullAppConfigs(makeContext());

    expect(getR2ObjectMock).toHaveBeenCalled();
    expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalled();
  });
});
