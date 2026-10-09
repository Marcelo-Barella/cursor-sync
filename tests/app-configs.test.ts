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

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
  }),
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
  ],
}));

vi.mock("../src/packaging.js", () => ({
  packageFiles: async () => ({
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
}));

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

const getAppSessionMock = vi.hoisted(() => vi.fn());
const getR2StorageCredentialsMock = vi.hoisted(() => vi.fn());
const putR2ObjectMock = vi.hoisted(() => vi.fn());
const getR2ObjectMock = vi.hoisted(() => vi.fn());
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

function makeContext(): vscode.ExtensionContext {
  return {
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
    globalState: {
      get: () => undefined,
      update: async () => {},
    },
  } as unknown as vscode.ExtensionContext;
}

describe("app-configs API", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockReset();
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
      "Log in to Cursor Sync to sync configs with the app."
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
      "Log in to Cursor Sync to sync configs with the app."
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
    showErrorMessageMock.mockReset();
    showInformationMessageMock.mockReset();
    showQuickPickMock.mockReset();
    getAppSessionMock.mockReset();
    getR2StorageCredentialsMock.mockReset();
    putR2ObjectMock.mockReset();
    getR2ObjectMock.mockReset();
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
    putR2ObjectMock.mockResolvedValue(undefined);
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

  it("push uploads encrypted bytes to R2 and PUTs manifestCiphertext", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext());

    expect(ok).toBe(true);
    expect(putEncryptedR2ObjectMock).toHaveBeenCalled();
    expect(putConfigsManifestWithRetryMock).toHaveBeenCalled();
  });

  it("pull reads encrypted manifest and R2 object bytes", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
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
            checksum: "abc",
            sizeBytes: 7,
          },
        },
      },
      files: {
        "cursor-user/settings.json": {
          checksum: "abc",
          sizeBytes: 7,
        },
      },
    });
    getEncryptedR2ObjectMock.mockResolvedValue(Buffer.from('{"from":"r2"}'));

    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePullAppConfigs(makeContext());

    expect(ok).toBe(true);
    expect(getEncryptedR2ObjectMock).toHaveBeenCalled();
  });
});
