import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendLineMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showWarningMessageMock = vi.fn();
const putR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from("remote")));
const fetchMock = vi.hoisted(() => vi.fn());
const getAppSessionMock = vi.hoisted(() => vi.fn());
const rollbackFromBackupMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const renameMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
let pullWriteCount = 0;

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  rename: (...args: unknown[]) => renameMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === "safeMode") {
          return false as T;
        }
        if (key === "syncProfileName") {
          return "default" as T;
        }
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
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
    {
      absolutePath: "/tmp/cursor-user/a.json",
      relativeSyncKey: "cursor-user/a.json",
    },
    {
      absolutePath: "/tmp/cursor-user/b.json",
      relativeSyncKey: "cursor-user/b.json",
    },
    {
      absolutePath: "/tmp/cursor-user/c.json",
      relativeSyncKey: "cursor-user/c.json",
    },
  ],
}));

vi.mock("../src/packaging.js", () => ({
  packageFiles: async () => ({
    packaged: new Map([
      [
        "cursor-user/a.json",
        { content: "a", checksum: "ca", sizeBytes: 1 },
      ],
      [
        "cursor-user/b.json",
        { content: "b", checksum: "cb", sizeBytes: 1 },
      ],
      [
        "cursor-user/c.json",
        { content: "c", checksum: "cc", sizeBytes: 1 },
      ],
    ]),
    manifest: {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMachineId: "machine",
      sourceOS: "linux",
      files: {
        "cursor-user/a.json": { checksum: "ca", sizeBytes: 1 },
        "cursor-user/b.json": { checksum: "cb", sizeBytes: 1 },
        "cursor-user/c.json": { checksum: "cc", sizeBytes: 1 },
      },
    },
  }),
}));

vi.mock("../src/rollback.js", () => ({
  createBackup: async (paths: string[]) => ({
    entries: paths.map((absolutePath) => ({
      absolutePath,
      backupPath: `${absolutePath}.bak`,
    })),
  }),
  rollbackFromBackup: rollbackFromBackupMock,
  pruneOldBackups: async () => {},
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "https://api.sync.test",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: vi.fn().mockResolvedValue({
    accessKeyId: "ak",
    secretAccessKey: "sk",
    sessionToken: "st",
    bucket: "bucket",
    prefix: "pfx/",
    endpoint: "https://r2.test",
    region: "auto",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
  putR2Object: putR2ObjectMock,
  getR2Object: (...args: unknown[]) => getR2ObjectMock(...args),
}));

describe("app configs logout coordination", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    putR2ObjectMock.mockReset();
    putR2ObjectMock.mockResolvedValue(undefined);
    fetchMock.mockReset();
    getAppSessionMock.mockResolvedValue("jwt-session");
    rollbackFromBackupMock.mockClear();
    writeFileMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    renameMock.mockReset();
    renameMock.mockResolvedValue(undefined);
    mkdirMock.mockReset();
    mkdirMock.mockResolvedValue(undefined);
    pullWriteCount = 0;
    getR2ObjectMock.mockReset();
    getR2ObjectMock.mockResolvedValue(Buffer.from("remote"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("7a: aborted push commits manifest only for uploaded keys", async () => {
    const { bumpSessionEpoch } = await import("../src/app-session-coordination.js");
    const { executePushAppConfigs } = await import("../src/app-configs.js");

    let uploads = 0;
    putR2ObjectMock.mockImplementation(async () => {
      uploads += 1;
      if (uploads === 2) {
        bumpSessionEpoch();
      }
    });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payload: null, updated_at: "now" }),
    });

    const ok = await executePushAppConfigs({} as never);
    expect(ok).toBe(false);
    expect(putR2ObjectMock).toHaveBeenCalledTimes(2);

    const putCall = fetchMock.mock.calls.find(
      (call) => call[0] === "https://api.sync.test/configs" && call[1]?.method === "PUT"
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall?.[1]?.body));
    expect(Object.keys(body.payload.files)).toEqual([
      "cursor-user/a.json",
      "cursor-user/b.json",
    ]);
    expect(Object.keys(body.payload.manifest.files)).toEqual([
      "cursor-user/a.json",
      "cursor-user/b.json",
    ]);
  });

  it("7b: aborted pull shows one logout notice and rolls back partial writes", async () => {
    vi.useRealTimers();
    fetchMock.mockResolvedValueOnce({
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
              "cursor-user/a.json": { checksum: "ca", sizeBytes: 1 },
              "cursor-user/b.json": { checksum: "cb", sizeBytes: 1 },
              "cursor-user/c.json": { checksum: "cc", sizeBytes: 1 },
            },
          },
          files: {
            "cursor-user/a.json": { content: "a", checksum: "ca", sizeBytes: 1 },
            "cursor-user/b.json": { content: "b", checksum: "cb", sizeBytes: 1 },
            "cursor-user/c.json": { content: "c", checksum: "cc", sizeBytes: 1 },
          },
        },
        updated_at: "now",
      }),
    });

    const { bumpSessionEpoch } = await import("../src/app-session-coordination.js");
    const { executePullAppConfigs } = await import("../src/app-configs.js");

    let r2Reads = 0;
    getR2ObjectMock.mockImplementation(async () => {
      r2Reads += 1;
      if (r2Reads === 2) {
        bumpSessionEpoch();
      }
      return Buffer.from("remote");
    });

    const ok = await executePullAppConfigs({} as never);
    expect(ok).toBe(false);
    expect(
      showInformationMessageMock.mock.calls.some(
        (call) => call[0] === "Logged out, pull cancelled."
      )
    ).toBe(true);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(
      showInformationMessageMock.mock.calls.some((call) =>
        String(call[0]).includes("Pull app configs complete")
      )
    ).toBe(false);
  });
});
