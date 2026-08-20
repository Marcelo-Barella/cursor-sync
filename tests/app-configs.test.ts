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

vi.mock("../src/app-auth.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: getR2StorageCredentialsMock,
  putR2Object: putR2ObjectMock,
  getR2Object: getR2ObjectMock,
}));

function makeContext(): vscode.ExtensionContext {
  return {
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
  });

  it("pull prefers R2 bytes and falls back to legacy payload content", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    getR2ObjectMock.mockResolvedValue(undefined);
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

    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePullAppConfigs(makeContext());

    expect(ok).toBe(true);
    expect(getR2ObjectMock).toHaveBeenCalled();
  });
});
