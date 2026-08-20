import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

const executePushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const isPushLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const isPullLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const getAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => true, size: 100 }),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

vi.mock("../src/push.js", () => ({
  executePush: executePushMock,
  isPushLocked: isPushLockedMock,
}));

vi.mock("../src/pull.js", () => ({
  executePull: executePullMock,
  isPullLocked: isPullLockedMock,
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

function mockContext(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-test" },
    globalState: {
      get: vi.fn().mockReturnValue("test-client-id"),
      update: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async (key: string) =>
        key === "cursorSync.githubPAT" ? "ghp_test_token" : undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

function extensionVersion(): string {
  return (
    JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
}

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start when schedule.enabled is false", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return false;
        if (key === "schedule.intervalMin") return 30;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);

    vi.advanceTimersByTime(120_000);
    stopScheduler();
  });

  it("enforces minimum interval of 5 minutes", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 1;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);

    const pushModule = await import("../src/push.js");
    const pushSpy = vi.spyOn(pushModule, "executePush").mockResolvedValue(true);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);

    await vi.advanceTimersByTimeAsync(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(pushSpy).toHaveBeenCalledTimes(2);

    stopScheduler();
    pushSpy.mockRestore();
  });

  it("stops timer on stopScheduler", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 5;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);
    stopScheduler();

    vi.advanceTimersByTime(10 * 60 * 1000);
  });
});

describe("determineSyncAction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns push when no sync state exists", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "push" });
  });

  it("returns push when sync state has no gistId", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "",
      localChecksums: {},
      remoteChecksums: {},
    });

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "push" });
  });

  it("returns error when no token available", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: {},
      remoteChecksums: {},
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue(undefined);

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "error", reason: "no_token" });
  });

  it("returns none when local and remote checksums match state", async () => {
    const checksums = { "cursor-user/settings.json": "aaa111" };

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: checksums,
      remoteChecksums: checksums,
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("fake-token");

    const gist = await import("../src/gist.js");
    vi.spyOn(gist.GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: {
        id: "abc123",
        html_url: "",
        description: "",
        files: {
          "manifest.json": {
            content: JSON.stringify({
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: new Date().toISOString(),
              sourceMachineId: "machine1",
              sourceOS: "linux",
              files: { "cursor-user/settings.json": { checksum: "aaa111", sizeBytes: 100 } },
            }),
          },
        },
        created_at: "",
        updated_at: "",
      },
    });

    const retry = await import("../src/retry.js");
    vi.spyOn(retry, "withRetry").mockImplementation((fn: () => unknown) => fn());

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: "/tmp/settings.json", relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("content"));

    const packaging = await import("../src/packaging.js");
    vi.spyOn(packaging, "computeChecksum").mockReturnValue("aaa111");

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => "fake-token", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "none" });
  });

  it("returns pull when remote checksums differ from state", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: { "cursor-user/settings.json": "aaa111" },
      remoteChecksums: { "cursor-user/settings.json": "aaa111" },
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("fake-token");

    const gist = await import("../src/gist.js");
    vi.spyOn(gist.GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: {
        id: "abc123",
        html_url: "",
        description: "",
        files: {
          "manifest.json": {
            content: JSON.stringify({
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: new Date().toISOString(),
              sourceMachineId: "machine2",
              sourceOS: "linux",
              files: { "cursor-user/settings.json": { checksum: "bbb222", sizeBytes: 120 } },
            }),
          },
        },
        created_at: "",
        updated_at: "",
      },
    });

    const retry = await import("../src/retry.js");
    vi.spyOn(retry, "withRetry").mockImplementation((fn: () => unknown) => fn());

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: "/tmp/settings.json", relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("content"));

    const packaging = await import("../src/packaging.js");
    vi.spyOn(packaging, "computeChecksum").mockReturnValue("aaa111");

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => "fake-token", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "pull" });
  });

  it("returns push when local checksums differ from state", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: { "cursor-user/settings.json": "aaa111" },
      remoteChecksums: { "cursor-user/settings.json": "aaa111" },
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("fake-token");

    const gist = await import("../src/gist.js");
    vi.spyOn(gist.GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: {
        id: "abc123",
        html_url: "",
        description: "",
        files: {
          "manifest.json": {
            content: JSON.stringify({
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: new Date().toISOString(),
              sourceMachineId: "machine1",
              sourceOS: "linux",
              files: { "cursor-user/settings.json": { checksum: "aaa111", sizeBytes: 100 } },
            }),
          },
        },
        created_at: "",
        updated_at: "",
      },
    });

    const retry = await import("../src/retry.js");
    vi.spyOn(retry, "withRetry").mockImplementation((fn: () => unknown) => fn());

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: "/tmp/settings.json", relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("new-content"));

    const packaging = await import("../src/packaging.js");
    vi.spyOn(packaging, "computeChecksum").mockReturnValue("ccc333");

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => "fake-token", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "push" });
  });

  it("returns pull-push when both local and remote changed different files", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: {
        "cursor-user/settings.json": "aaa111",
        "cursor-user/keybindings.json": "bbb222",
      },
      remoteChecksums: {
        "cursor-user/settings.json": "aaa111",
        "cursor-user/keybindings.json": "bbb222",
      },
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("fake-token");

    const gist = await import("../src/gist.js");
    vi.spyOn(gist.GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: {
        id: "abc123",
        html_url: "",
        description: "",
        files: {
          "manifest.json": {
            content: JSON.stringify({
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: new Date().toISOString(),
              sourceMachineId: "machine2",
              sourceOS: "linux",
              files: {
                "cursor-user/settings.json": { checksum: "aaa111", sizeBytes: 100 },
                "cursor-user/keybindings.json": { checksum: "ddd444", sizeBytes: 200 },
              },
            }),
          },
        },
        created_at: "",
        updated_at: "",
      },
    });

    const retry = await import("../src/retry.js");
    vi.spyOn(retry, "withRetry").mockImplementation((fn: () => unknown) => fn());

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: "/tmp/settings.json", relativeSyncKey: "cursor-user/settings.json" },
      { absolutePath: "/tmp/keybindings.json", relativeSyncKey: "cursor-user/keybindings.json" },
    ]);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("content"));

    const packaging = await import("../src/packaging.js");
    vi.spyOn(packaging, "computeChecksum")
      .mockReturnValueOnce("ccc333")
      .mockReturnValueOnce("bbb222");

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => "fake-token", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result).toEqual({ action: "pull-push" });
  });

  it("returns conflict when same file changed both locally and remotely", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abc123",
      localChecksums: { "cursor-user/settings.json": "aaa111" },
      remoteChecksums: { "cursor-user/settings.json": "aaa111" },
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("fake-token");

    const gist = await import("../src/gist.js");
    vi.spyOn(gist.GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: {
        id: "abc123",
        html_url: "",
        description: "",
        files: {
          "manifest.json": {
            content: JSON.stringify({
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: new Date().toISOString(),
              sourceMachineId: "machine2",
              sourceOS: "linux",
              files: { "cursor-user/settings.json": { checksum: "bbb222", sizeBytes: 120 } },
            }),
          },
        },
        created_at: "",
        updated_at: "",
      },
    });

    const retry = await import("../src/retry.js");
    vi.spyOn(retry, "withRetry").mockImplementation((fn: () => unknown) => fn());

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: "/tmp/settings.json", relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const fsPromises = await import("node:fs/promises");
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("local-changed"));

    const packaging = await import("../src/packaging.js");
    vi.spyOn(packaging, "computeChecksum").mockReturnValue("ccc333");

    const { determineSyncAction } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => "fake-token", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    const result = await determineSyncAction(context);
    expect(result.action).toBe("conflict");
    if (result.action === "conflict") {
      expect(result.keys).toEqual(["cursor-user/settings.json"]);
    }
  });
});

describe("scheduled sync debug wiring", () => {
  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();
    executePushMock.mockReset().mockResolvedValue(true);
    executePullMock.mockReset().mockResolvedValue(true);
    isPushLockedMock.mockReset().mockReturnValue(false);
    isPullLockedMock.mockReset().mockReturnValue(false);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls showSyncFailureWithDebug on determineSyncAction error", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "error",
      reason: "no_token",
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      message: "no_token",
      category: "no_token",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Scheduled sync failed: no_token" });
  });

  it("calls showSyncFailureWithDebug on determineSyncAction conflict with warning", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json"],
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      category: "CONFLICT",
      conflictCount: 1,
      message: "1 conflict(s) detected. Resolve them first.",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({
      level: "warning",
      title: "1 conflict(s) detected. Resolve them first.",
    });
  });

  it("does not duplicate debug toast when scheduled pull fails via executePull", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull",
    });

    executePullMock.mockImplementation(async (context, options) => {
      const { executePull } = await vi.importActual<
        typeof import("../src/pull.js")
      >("../src/pull.js");
      return executePull(context, options);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue(undefined);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: {},
      remoteChecksums: {},
    });

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "pull",
      direction: "pull",
      trigger: "scheduled",
      category: "AUTH_FAILED",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });

  it("does not call showSyncFailureWithDebug when scheduled pull mock returns false", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull",
    });
    executePullMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled push mock returns false", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "push",
    });
    executePushMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled pull-push pull mock fails", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull-push",
    });
    executePullMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(executePushMock).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when scheduled pull-push push mock fails", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull-push",
    });
    executePullMock.mockResolvedValue(true);
    executePushMock.mockResolvedValue(false);

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("calls showSyncFailureWithDebug when scheduledTick catches", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockRejectedValue(
      new Error("tick exception")
    );

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "scheduler",
      trigger: "scheduled",
      message: "tick exception",
    });
    expect(options).toMatchObject({
      title: "Scheduled sync failed: tick exception",
    });
  });

  it("does not call showSyncFailureWithDebug when already in sync", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "none",
    });

    await scheduler.scheduledTick(mockContext());

    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("does not call showSyncFailureWithDebug when sync is in progress", async () => {
    isPushLockedMock.mockReturnValue(true);

    const scheduler = await import("../src/scheduler.js");
    const determineSpy = vi.spyOn(
      scheduler.scheduledSyncActionResolver,
      "determineSyncAction"
    );

    await scheduler.scheduledTick(mockContext());

    expect(determineSpy).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebugMock).not.toHaveBeenCalled();
  });

  it("skips scheduled Gist push when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "push",
    });

    await scheduler.scheduledTick(mockContext());

    expect(executePushMock).not.toHaveBeenCalled();
  });

  it("skips scheduled Gist push after pull when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "pull-push",
    });
    executePullMock.mockResolvedValue(true);

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalled();
    expect(executePushMock).not.toHaveBeenCalled();
  });
});
