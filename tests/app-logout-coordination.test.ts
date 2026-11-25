import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const appendLineMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showWarningMessageMock = vi.fn();
const putR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from("remote")));
const fetchMock = vi.hoisted(() => vi.fn());
const getAppSessionMock = vi.hoisted(() => vi.fn());

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
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (progress: { report: (v: { message?: string }) => void }) => Promise<void>
      ) => task({ report: vi.fn() })
    ),
    ProgressLocation: { Notification: 15 },
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

const coordDek = vi.hoisted(() => Buffer.alloc(32, 9));

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
    resolveSyncRoots: () => ({
      cursorUser: "/tmp/cursor-user-coord",
      dotCursor: "/tmp/dot-cursor-coord",
    }),
    enumerateSyncFiles: async () => [
      { absolutePath: "/tmp/cursor-user-coord/a.json", relativeSyncKey: "cursor-user/a.json" },
      { absolutePath: "/tmp/cursor-user-coord/b.json", relativeSyncKey: "cursor-user/b.json" },
      { absolutePath: "/tmp/cursor-user-coord/c.json", relativeSyncKey: "cursor-user/c.json" },
    ],
    listSymlinkSyncKeysUnderRoots: async () => [],
  };
});

vi.mock("../src/e2e/gate.js", () => ({
  requireE2eUnlocked: async () => ({
    ok: true,
    kind: "dek",
    userId: "user-1",
    keyVersion: 1,
    dek: coordDek,
  }),
  isE2eDekUnlocked: (result: { ok?: boolean; kind?: string }) =>
    result?.ok === true && result.kind === "dek",
}));

vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return {
    ...actual,
    scanLocalAppConfigFiles: async () => ({
      checksums: { "cursor-user/a.json": "local-before" },
      unreadableKeys: new Set<string>(),
      enoentKeys: new Set<string>(),
      provablyAbsentKeys: new Set<string>(["cursor-user/b.json", "cursor-user/c.json"]),
      skippedUnknownKeys: new Set<string>(),
      untrackedKeys: new Set<string>(),
      absentEligibleKeys: new Set<string>(["cursor-user/b.json", "cursor-user/c.json"]),
      deletesAllowed: true,
      enumeratedCount: 3,
      rootsHealthy: true,
      trackingScopeMismatch: false,
      deleteBlockedRootPrefixes: new Set<string>(),
    }),
  };
});

vi.mock("../src/app-config-disk-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-disk-probe.js")>();
  return {
    ...actual,
    scanWithDiskProbes: async (_context: unknown, scan: unknown) => scan,
  };
});

vi.mock("../src/packaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging.js")>();
  return {
    ...actual,
    packageFiles: async () => ({
      skipped: [],
      packaged: new Map([
        ["cursor-user/a.json", { content: "a", checksum: "ca", sizeBytes: 1 }],
        ["cursor-user/b.json", { content: "b", checksum: "cb", sizeBytes: 1 }],
        ["cursor-user/c.json", { content: "c", checksum: "cc", sizeBytes: 1 }],
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
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "https://api.sync.test",
}));

vi.mock("../src/e2e/r2-storage.js", () => ({
  putEncryptedR2Object: async (
    credentials: unknown,
    _dek: unknown,
    _userId: unknown,
    _keyVersion: unknown,
    syncKey: unknown,
    body: unknown,
    options?: unknown
  ) => putR2ObjectMock(credentials, syncKey, body, options),
  getEncryptedR2Object: async (
    credentials: unknown,
    _dek: unknown,
    _userId: unknown,
    _keyVersion: unknown,
    syncKey: unknown,
    options?: unknown
  ) => getR2ObjectMock(credentials, syncKey, options),
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

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: vi.fn(),
}));

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

async function makeContext() {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-coord-"));
  const cursorUser = "/tmp/cursor-user-coord";
  await fs.mkdir(cursorUser, { recursive: true });
  const state: Record<string, unknown> = {};
  return {
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: <T>(key: string) => state[key] as T,
      update: async (key: string, value: unknown) => {
        state[key] = value;
      },
    },
  } as never;
}

describe("app configs logout coordination", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    putR2ObjectMock.mockReset();
    putR2ObjectMock.mockResolvedValue(undefined);
    fetchMock.mockReset();
    getAppSessionMock.mockResolvedValue("jwt-session");
    getR2ObjectMock.mockReset();
    getR2ObjectMock.mockResolvedValue(Buffer.from("remote"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { __resetAppSessionCoordinationForTests } = await import(
      "../src/app-session-coordination.js"
    );
    __resetAppSessionCoordinationForTests();
  });

  it("7a: aborted push merges uploaded keys into full remote manifest", async () => {
    const { bumpSessionEpoch } = await import("../src/app-session-coordination.js");
    const { executePushAppConfigs } = await import("../src/app-configs.js");

    let uploads = 0;
    putR2ObjectMock.mockImplementation(async () => {
      uploads += 1;
      if (uploads === 2) {
        bumpSessionEpoch();
      }
    });

    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: remoteBaseline, updated_at: "now" }),
        };
      }
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ payload: remoteBaseline, updated_at: "now" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const ok = await executePushAppConfigs(await makeContext());
    expect(ok).toBe(false);
    expect(putR2ObjectMock).toHaveBeenCalledTimes(2);

    const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall?.[1]?.body)) as { manifestCiphertext: string };
    const { decryptManifestPayload } = await import("../src/e2e/configs-sync.js");
    const decoded = decryptManifestPayload(coordDek, "user-1", 1, body.manifestCiphertext);
    expect(Object.keys(decoded.manifest.files).sort()).toEqual([
      "cursor-user/a.json",
      "cursor-user/b.json",
      "cursor-user/c.json",
    ]);
    expect(decoded.manifest.files["cursor-user/c.json"]?.checksum).toBe("cc0");
    expect(decoded.manifest.files["cursor-user/a.json"]?.checksum).toBe("ca");
  });

  it("7b: aborted pull shows one logout notice and rolls back partial writes", async () => {
    const ctx = await makeContext();
    await fs.writeFile("/tmp/cursor-user-coord/a.json", "local-before", "utf-8");
    const checksum = (
      await import("../src/packaging.js")
    ).computeChecksum(Buffer.from("remote"));

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
              "cursor-user/a.json": { checksum, sizeBytes: 6 },
              "cursor-user/b.json": { checksum, sizeBytes: 6 },
              "cursor-user/c.json": { checksum, sizeBytes: 6 },
            },
          },
          files: {
            "cursor-user/a.json": { content: "remote", checksum, sizeBytes: 6 },
            "cursor-user/b.json": { content: "remote", checksum, sizeBytes: 6 },
            "cursor-user/c.json": { content: "remote", checksum, sizeBytes: 6 },
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

    const ok = await executePullAppConfigs(ctx);
    expect(ok).toBe("failure");
    expect(await fs.readFile("/tmp/cursor-user-coord/a.json", "utf-8")).toBe("local-before");
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
