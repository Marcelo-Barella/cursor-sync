import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    vi.spyOn(retry, "withRetry").mockImplementation((fn: any) => fn());

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
    vi.spyOn(retry, "withRetry").mockImplementation((fn: any) => fn());

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
    vi.spyOn(retry, "withRetry").mockImplementation((fn: any) => fn());

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
    vi.spyOn(retry, "withRetry").mockImplementation((fn: any) => fn());

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
    vi.spyOn(retry, "withRetry").mockImplementation((fn: any) => fn());

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
