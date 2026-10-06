import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const showErrorMessageMock = vi.fn();
const appendLineMock = vi.fn();

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
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
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
    { absolutePath: "/tmp/cursor-user/a.json", relativeSyncKey: "cursor-user/a.json" },
    { absolutePath: "/tmp/cursor-user/b.json", relativeSyncKey: "cursor-user/b.json" },
    { absolutePath: "/tmp/cursor-user/c.json", relativeSyncKey: "cursor-user/c.json" },
  ],
}));

vi.mock("../src/packaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging.js")>();
  const files = {
    "cursor-user/a.json": { content: "a", checksum: "ca", sizeBytes: 1 },
    "cursor-user/b.json": { content: "b", checksum: "cb", sizeBytes: 1 },
    "cursor-user/c.json": { content: "c", checksum: "cc", sizeBytes: 1 },
  };
  return {
    ...actual,
    packageFiles: async () => ({
      packaged: new Map(Object.entries(files)),
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        files: Object.fromEntries(
          Object.entries(files).map(([k, v]) => [k, { checksum: v.checksum, sizeBytes: v.sizeBytes }])
        ),
      },
    }),
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

const getAppSessionMock = vi.hoisted(() => vi.fn());
const putR2ObjectMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: vi.fn().mockResolvedValue({
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "sync-bucket",
    region: "auto",
    prefix: "users/user-1/",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    sessionToken: "session-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }),
  putR2Object: putR2ObjectMock,
  getR2Object: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
  const state: Record<string, unknown> = {};
  return {
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
    globalStorageUri: { fsPath: "/tmp/cursor-sync-push-abort-storage" },
    globalState: {
      get: <T>(key: string) => state[key] as T,
      update: async (key: string, value: unknown) => {
        state[key] = value;
      },
    },
  } as unknown as vscode.ExtensionContext;
}

const remoteBaseline = {
  schemaVersion: 1,
  manifest: {
    schemaVersion: 1,
    syncProfileName: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceMachineId: "remote",
    sourceOS: "linux",
    files: {
      "cursor-user/a.json": { checksum: "ca0", sizeBytes: 1 },
      "cursor-user/b.json": { checksum: "cb0", sizeBytes: 1 },
      "cursor-user/c.json": { checksum: "cc0", sizeBytes: 1 },
    },
  },
  files: {
    "cursor-user/a.json": { checksum: "ca0", sizeBytes: 1 },
    "cursor-user/b.json": { checksum: "cb0", sizeBytes: 1 },
    "cursor-user/c.json": { checksum: "cc0", sizeBytes: 1 },
  },
};

describe("app-configs push abort and errors", () => {
  beforeEach(() => {
    vi.resetModules();
    showErrorMessageMock.mockReset();
    appendLineMock.mockReset();
    getAppSessionMock.mockResolvedValue("jwt-token");
    putR2ObjectMock.mockReset();
    putR2ObjectMock.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("partial abort PUT keeps full remote key set in manifest", async () => {
    const putBodies: string[] = [];
    let uploadCount = 0;
    putR2ObjectMock.mockImplementation(async () => {
      uploadCount += 1;
      if (uploadCount === 2) {
        const { bumpSessionEpoch } = await import("../src/app-session-coordination.js");
        bumpSessionEpoch();
      }
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: remoteBaseline, updated_at: "2026-01-01T00:00:00.000Z" }),
        };
      }
      if (init?.method === "PUT") {
        putBodies.push(init.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: remoteBaseline, updated_at: "2026-01-02T00:00:00.000Z" }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext());
    expect(ok).toBe(false);
    expect(putBodies.length).toBeGreaterThanOrEqual(1);
    const partialBody = JSON.parse(putBodies[putBodies.length - 1]!);
    expect(Object.keys(partialBody.payload.manifest.files).sort()).toEqual([
      "cursor-user/a.json",
      "cursor-user/b.json",
      "cursor-user/c.json",
    ]);
    expect(partialBody.payload.manifest.files["cursor-user/c.json"].checksum).toBe("cc0");
    expect(partialBody.payload.manifest.files["cursor-user/a.json"].checksum).toBe("ca");
  });

  it("shows session expired on 401 PUT without logout abort", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: null, updated_at: "2026-01-01T00:00:00.000Z" }),
        };
      }
      return { ok: false, status: 401, text: async () => "unauthorized" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { executePushAppConfigs } = await import("../src/app-configs.js");
    await executePushAppConfigs(makeContext());

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Your Cursor Sync session expired. Log in again to sync configs with the app."
    );
  });

  it("marks remote dirty when metadata commit fails after uploads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: null, updated_at: "2026-01-01T00:00:00.000Z" }),
        };
      }
      return { ok: false, status: 500, text: async () => "server error" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeContext();
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    await executePushAppConfigs(ctx);

    const { readAppConfigRemoteDirty } = await import("../src/app-config-remote-state.js");
    expect(readAppConfigRemoteDirty(ctx)?.reason).toBe("push_failed_after_upload");
  });

  it("marks remote dirty when partial commit is refused", async () => {
    let uploadCount = 0;
    putR2ObjectMock.mockImplementation(async () => {
      uploadCount += 1;
      if (uploadCount === 1) {
        const { bumpSessionEpoch } = await import("../src/app-session-coordination.js");
        bumpSessionEpoch();
      }
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: remoteBaseline, updated_at: "2026-01-01T00:00:00.000Z" }),
        };
      }
      return { ok: false, status: 500, text: async () => "refused" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeContext();
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    await executePushAppConfigs(ctx);

    const { readAppConfigRemoteDirty } = await import("../src/app-config-remote-state.js");
    expect(readAppConfigRemoteDirty(ctx)?.reason).toBe("partial_commit_failed");
  });

  it("times out hung config PUT", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        })
      )
    );

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
    const putPromise = putAppConfigs(makeContext(), payload);
    await Promise.all([
      expect(putPromise).rejects.toThrow(/timed out waiting for config PUT/i),
      vi.advanceTimersByTimeAsync(16_000),
    ]);
    vi.useRealTimers();
  });
});
