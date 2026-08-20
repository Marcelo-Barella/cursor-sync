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

vi.mock("../src/app-auth.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
  getAppSession: getAppSessionMock,
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
