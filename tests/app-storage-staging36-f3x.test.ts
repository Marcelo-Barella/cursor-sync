import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { computeChecksum } from "../src/packaging.js";
import {
  APP_STORAGE_BASELINE_SCHEMA_VERSION,
  classifyAppStorageKeys,
  loadAppStorageBaseline,
  saveAppStorageBaseline,
} from "../src/app-storage-baseline.js";

const SYNC_KEY = "cursor-user/settings.json";
const REMOTE_BODY = Buffer.from('{"remote":true}');
const EDITED_BODY = Buffer.from('{"edited":true}');
const REMOTE_CHK = computeChecksum(REMOTE_BODY);
const EDITED_CHK = computeChecksum(EDITED_BODY);
const REMOTE2_BODY = Buffer.from('{"remote":"v2"}');
const REMOTE2_CHK = computeChecksum(REMOTE2_BODY);
const showQuickPickMock = vi.hoisted(() => vi.fn());
const safeModeRef = vi.hoisted(() => ({ value: true }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === "appApiUrl") return "http://localhost:8100" as T;
        if (key === "syncProfileName") return "default" as T;
        if (key === "safeMode") return safeModeRef.value as T;
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: showQuickPickMock,
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn() }),
  addSyncHistoryEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/extensions.js", () => ({ generateExtensionsJson: () => "[]" }));

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
    syncKeyToAbsolutePath: (syncKey: string) =>
      syncKey === SYNC_KEY ? "/tmp/cursor-user/settings.json" : undefined,
    enumerateSyncFiles: async () => [
      { absolutePath: "/tmp/cursor-user/settings.json", relativeSyncKey: SYNC_KEY },
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
  };
});

const scanLocalAppConfigFilesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return { ...actual, scanLocalAppConfigFiles: scanLocalAppConfigFilesMock };
});

vi.mock("../src/app-config-disk-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-disk-probe.js")>();
  return {
    ...actual,
    scanWithDiskProbes: async (
      _ctx: unknown,
      scan: import("../src/app-config-local-scan.js").LocalConfigFileScan
    ) => scan,
    writeFileWithoutFollow: writeWithoutFollowMock,
  };
});

vi.mock("../src/app-config-sync-path-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-sync-path-safety.js")>();
  return {
    ...actual,
    assertSafePullTarget: vi.fn().mockResolvedValue(undefined),
    resolveSyncRootsRealpaths: vi.fn().mockImplementation(async (roots: { cursorUser: string; dotCursor: string }) => ({
      cursorUser: { rootPath: roots.cursorUser, rootReal: roots.cursorUser },
      dotCursor: { rootPath: roots.dotCursor, rootReal: roots.dotCursor },
    })),
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: async () => ({ entries: [], failedPaths: [] }),
  rollbackFromBackup: async () => {},
  pruneOldBackups: async () => {},
}));

const diskStore = vi.hoisted(() => new Map<string, Buffer>());
const writeWithoutFollowMock = vi.hoisted(() =>
  vi.fn(async (absolutePath: string, content: Buffer) => {
    diskStore.set(String(absolutePath), content);
  })
);
const writeFileMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (p: string, data: string | Buffer) => {
    diskStore.set(String(p), Buffer.isBuffer(data) ? data : Buffer.from(data));
  })
);
const readFileMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (p: string) => {
    const key = String(p);
    if (key.endsWith("settings.json")) {
      return EDITED_BODY;
    }
    const hit = diskStore.get(key);
    if (hit) {
      return hit;
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  })
);

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: writeFileMock,
  readFile: readFileMock,
  rename: vi.fn().mockResolvedValue(undefined),
}));

const getAppSessionMock = vi.hoisted(() => vi.fn());
const putR2ObjectMock = vi.hoisted(() => vi.fn());
const getR2ObjectMock = vi.hoisted(() => vi.fn());
const getR2StorageCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({ getAppSession: getAppSessionMock }));
vi.mock("../src/config/urls.js", () => ({ getAppApiUrl: () => "http://localhost:8100" }));
vi.mock("../src/app-session-identity.js", () => ({
  appStorageAccountKey: () => "acct-test",
}));
vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: getR2StorageCredentialsMock,
  putR2Object: putR2ObjectMock,
  getR2Object: getR2ObjectMock,
  deleteR2Object: vi.fn(),
}));

function remotePayload(checksum: string) {
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMachineId: "machine",
      sourceOS: "linux",
      files: {
        [SYNC_KEY]: { checksum, sizeBytes: REMOTE_BODY.length },
      },
    },
    files: {
      [SYNC_KEY]: {
        content: REMOTE_BODY.toString("base64"),
        encoding: "base64",
      },
    },
  };
}

function makeContext(): vscode.ExtensionContext {
  const baselineStore: Record<string, unknown> = {};
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-f3x" },
    globalState: {
      get: (key: string) => baselineStore[key],
      update: async (key: string, value: unknown) => {
        baselineStore[key] = value;
      },
    },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  } as unknown as vscode.ExtensionContext;
}

async function seedBaseline(context: vscode.ExtensionContext): Promise<void> {
  await saveAppStorageBaseline(context, {
    schemaVersion: APP_STORAGE_BASELINE_SCHEMA_VERSION,
    accountKey: "acct-test",
    destination: "cursor-sync-storage",
    remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
    localChecksums: { [SYNC_KEY]: REMOTE_CHK },
    remoteChecksums: { [SYNC_KEY]: REMOTE_CHK },
  });
}

describe("staging.36 F3-X decline pull then Sync Now push", () => {
  beforeEach(async () => {
    vi.resetModules();
    diskStore.clear();
    safeModeRef.value = true;
    showQuickPickMock.mockReset();
    putR2ObjectMock.mockReset().mockResolvedValue(200);
    getR2ObjectMock.mockReset().mockResolvedValue(REMOTE_BODY);
    getAppSessionMock.mockResolvedValue("jwt");
    getR2StorageCredentialsMock.mockResolvedValue({
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "sync-bucket",
      region: "auto",
      prefix: "users/user-1/",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    putR2ObjectMock.mockResolvedValue(200);
    getR2ObjectMock.mockResolvedValue(REMOTE_BODY);
    scanLocalAppConfigFilesMock.mockReset();
    scanLocalAppConfigFilesMock.mockResolvedValue({
      checksums: { [SYNC_KEY]: EDITED_CHK },
      unreadableKeys: new Set(),
      excludedKeys: new Set(),
      oversizeKeys: new Set(),
      symlinkKeys: new Set(),
      underSymlinkedDirKeys: new Set(),
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
    });
    readFileMock.mockImplementation(async (p: string) => {
      const key = String(p);
      if (key.endsWith("settings.json")) {
        return diskStore.get(key) ?? EDITED_BODY;
      }
      const hit = diskStore.get(key);
      if (hit) {
        return hit;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("safeMode true: decline overwrite, baseline unchanged, Sync Now pushes edit, then remote drift is conflict", async () => {
    const ctx = makeContext();
    await seedBaseline(ctx);

    const { mockFetchJsonResponse } = await import("./mock-fetch-json.js");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        mockFetchJsonResponse({
          payload: remotePayload(REMOTE_CHK),
          updated_at: "2026-01-01T00:00:00.000Z",
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    showQuickPickMock.mockImplementation(async (items: { label: string; picked?: boolean }[]) => {
      expect(items).toHaveLength(1);
      expect(items[0]?.label).toBe(SYNC_KEY);
      expect(items[0]?.picked).toBe(false);
      return [];
    });

    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const pullStatus = await executePullAppConfigs(ctx, { trigger: "manual" });
    expect(pullStatus).toBe("success");
    const settingsWrites = writeFileMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("settings.json")
    );
    expect(settingsWrites).toHaveLength(0);

    const afterPull = await loadAppStorageBaseline(ctx, "acct-test", "cursor-sync-storage");
    expect(afterPull?.localChecksums[SYNC_KEY]).toBe(REMOTE_CHK);

    const { determineAppStorageSyncAction, executePushAppConfigs } = await import(
      "../src/app-configs.js"
    );
    const plan = await determineAppStorageSyncAction(ctx, { trigger: "syncNow" });
    expect(plan.action).toBe("push");
    if (plan.action === "push") {
      expect(plan.keys).toContain(SYNC_KEY);
    }

    vi.mocked(fetchMock).mockResolvedValue(
      mockFetchJsonResponse({
        payload: remotePayload(REMOTE_CHK),
        updated_at: "2026-01-01T00:00:00.000Z",
      })
    );

    const { packageFiles } = await import("../src/packaging.js");
    vi.spyOn(await import("../src/packaging.js"), "packageFiles").mockResolvedValue({
      skipped: [],
      packaged: new Map([
        [
          SYNC_KEY,
          { content: EDITED_BODY.toString("utf8"), checksum: EDITED_CHK, sizeBytes: EDITED_BODY.length },
        ],
      ]),
      manifest: remotePayload(EDITED_CHK).manifest,
    } as Awaited<ReturnType<typeof packageFiles>>);

    const pushOk = await executePushAppConfigs(ctx, { trigger: "syncNow" });
    expect(pushOk).toBe(true);
    expect(putR2ObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "users/user-1/" }),
      SYNC_KEY,
      EDITED_BODY
    );
    const putConfigs = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(putConfigs).toBeDefined();
    const putBody = JSON.parse(putConfigs![1]!.body as string);
    expect(putBody.payload.manifest.files[SYNC_KEY].checksum).toBe(EDITED_CHK);

    const afterPush = await loadAppStorageBaseline(ctx, "acct-test", "cursor-sync-storage");
    expect(afterPush?.localChecksums[SYNC_KEY]).toBe(EDITED_CHK);
    expect(afterPush?.remoteChecksums[SYNC_KEY]).toBe(EDITED_CHK);

    const EDITED2_BODY = Buffer.from('{"edited":"v2"}');
    const EDITED2_CHK = computeChecksum(EDITED2_BODY);

    vi.mocked(fetchMock).mockResolvedValue(
      mockFetchJsonResponse({
        payload: remotePayload(REMOTE2_CHK),
        updated_at: "2026-01-02T00:00:00.000Z",
      })
    );
    getR2ObjectMock.mockResolvedValue(REMOTE2_BODY);
    scanLocalAppConfigFilesMock.mockResolvedValue({
      checksums: { [SYNC_KEY]: EDITED2_CHK },
      unreadableKeys: new Set(),
      excludedKeys: new Set(),
      oversizeKeys: new Set(),
      symlinkKeys: new Set(),
      underSymlinkedDirKeys: new Set(),
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
    });

    const conflictPlan = await determineAppStorageSyncAction(ctx, { trigger: "syncNow" });
    expect(conflictPlan.action).toBe("conflict");
    const classified = classifyAppStorageKeys(
      { [SYNC_KEY]: EDITED2_CHK },
      { [SYNC_KEY]: REMOTE2_CHK },
      afterPush!
    );
    expect(classified.conflictKeys).toContain(SYNC_KEY);
  });

  it("safeMode false: manual pull overwrites without picker", async () => {
    vi.resetModules();
    safeModeRef.value = false;
    const ctx = makeContext();
    await saveAppStorageBaseline(ctx, {
      schemaVersion: APP_STORAGE_BASELINE_SCHEMA_VERSION,
      accountKey: "acct-test",
      destination: "cursor-sync-storage",
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: { [SYNC_KEY]: EDITED_CHK },
      remoteChecksums: { [SYNC_KEY]: EDITED_CHK },
    });

    const { mockFetchJsonResponse } = await import("./mock-fetch-json.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchJsonResponse({
          payload: remotePayload(REMOTE_CHK),
          updated_at: "2026-01-02T00:00:00.000Z",
        })
      )
    );

    writeWithoutFollowMock.mockClear();
    const { executePullAppConfigs } = await import("../src/app-configs.js");
    const status = await executePullAppConfigs(ctx, { trigger: "manual" });
    expect(status).toBe("success");
    expect(showQuickPickMock).not.toHaveBeenCalled();
    expect(writeWithoutFollowMock).toHaveBeenCalledWith(
      "/tmp/cursor-user/settings.json",
      REMOTE_BODY,
      expect.objectContaining({ syncKey: SYNC_KEY })
    );
    expect(diskStore.get("/tmp/cursor-user/settings.json")?.equals(REMOTE_BODY)).toBe(true);
    const afterPull = await loadAppStorageBaseline(ctx, "acct-test", "cursor-sync-storage");
    expect(afterPull?.remoteChecksums[SYNC_KEY]).toBe(REMOTE_CHK);
  });
});
