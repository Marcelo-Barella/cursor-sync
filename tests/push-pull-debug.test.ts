import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const showSyncFailureWithDebugMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

const determineSyncActionMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("../src/sync-debug.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-debug.js")>();
  return {
    ...actual,
    showSyncFailureWithDebug: showSyncFailureWithDebugMock,
  };
});

vi.mock("../src/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scheduler.js")>();
  return {
    ...actual,
    determineSyncAction: determineSyncActionMock,
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({
    isDirectory: () => true,
    isFile: () => true,
    size: 100,
  }),
  readdir: vi.fn().mockResolvedValue([]),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
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

describe("push/pull debug wiring", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();

    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "syncProfileName") return "default";
        if (key === "safeMode") return false;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls showSyncFailureWithDebug on push gist create failure", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/gists") && method === "GET") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [],
        } as Response;
      }

      if (url.includes("/gists") && method === "POST") {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ message: "Internal Server Error" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([]);
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({
      cursorUser: "/tmp/cursor-user",
      dotCursor: "/tmp/.cursor",
    });

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [context, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(context).toBeDefined();
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "NETWORK_ERROR",
      statusCode: 500,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toContain("Server error (500)");
    expect(options).toMatchObject({
      title: expect.stringContaining("Push failed:"),
    });
  });

  it("calls showSyncFailureWithDebug on pull getGist failure", async () => {
    const gistId = "abcdef1234567890abcdef1234567890";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith(`/gists/${gistId}`)) {
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({ message: "Not Found" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      gistId,
      localChecksums: {},
      remoteChecksums: {},
    });
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePull } = await import("../src/pull.js");
    const result = await executePull(mockContext(), { trigger: "scheduled" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "pull",
      direction: "pull",
      trigger: "scheduled",
      category: "UNKNOWN",
      statusCode: 404,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe("Not Found");
    expect(options).toMatchObject({
      title: expect.stringContaining("Pull failed:"),
    });
  });

  it("calls showSyncFailureWithDebug on push conflict blocker with warning metadata", async () => {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "pull",
      gistId: "abcdef1234567890abcdef1234567890",
      localChecksums: { "cursor-user/settings.json": "local" },
      remoteChecksums: { "cursor-user/settings.json": "remote" },
    });
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const conflicts = await import("../src/conflicts.js");
    vi.spyOn(conflicts, "detectConflicts").mockResolvedValue([
      {
        relativeSyncKey: "cursor-user/settings.json",
        localChecksum: "local",
        remoteChecksum: "remote",
      },
    ]);
    vi.spyOn(conflicts, "getResolutionForKey").mockReturnValue(undefined);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "CONFLICT",
      conflictCount: 1,
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe(
      "1 conflict(s) detected. Resolve them before pushing."
    );
    expect(options).toMatchObject({
      level: "warning",
      title: "1 conflict(s) detected. Resolve them before pushing.",
    });
  });

  it("calls showSyncFailureWithDebug on push auth failure", async () => {
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(false);
    vi.spyOn(auth, "requireToken").mockResolvedValue(undefined);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePush } = await import("../src/push.js");
    const result = await executePush(mockContext(), { trigger: "manual" });

    expect(result).toBe(false);
    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);

    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "push",
      direction: "push",
      trigger: "manual",
      category: "AUTH_FAILED",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(failure.message).toBe(
      "GitHub token not configured. Configure your token to sync."
    );
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });

  it("calls showSyncFailureWithDebug on pull auth failure", async () => {
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
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);

    const { executePull } = await import("../src/pull.js");
    const result = await executePull(mockContext(), { trigger: "scheduled" });

    expect(result).toBe(false);
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
    expect(failure.message).toBe(
      "GitHub token not configured. Configure your token to sync."
    );
    expect(failure.message).not.toMatch(/ghp_/);
    expect(options).toMatchObject({
      title: "GitHub token not configured. Configure your token to sync.",
    });
  });
});

describe("sync now debug wiring", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    showSyncFailureWithDebugMock.mockClear();
    determineSyncActionMock.mockReset();

    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "syncProfileName") return "default";
        if (key === "safeMode") return false;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "getLogger").mockReturnValue({
      appendLine: vi.fn(),
    } as unknown as import("vscode").OutputChannel);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls showSyncFailureWithDebug on determineSyncAction error", async () => {
    determineSyncActionMock.mockResolvedValue({
      action: "error",
      reason: "no_token",
    });

    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      message: "no_token",
      category: "no_token",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Sync failed: no_token" });
  });

  it("calls showSyncFailureWithDebug on determineSyncAction conflict", async () => {
    determineSyncActionMock.mockResolvedValue({
      action: "conflict",
      keys: ["cursor-user/settings.json", "dot-cursor/mcp.json"],
    });

    const vscode = await import("vscode");
    const executeCommandSpy = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined);

    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      category: "CONFLICT",
      conflictCount: 2,
      message: "2 conflict(s) detected. Resolve them first.",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({
      level: "warning",
      title: "2 conflict(s) detected. Resolve them first.",
    });
    expect(executeCommandSpy).toHaveBeenCalledWith("cursorSync.resolveConflicts");
  });

  it("calls showSyncFailureWithDebug when executeSyncNow catches", async () => {
    determineSyncActionMock.mockRejectedValue(new Error("scheduler blew up"));

    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure, options] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({
      operation: "syncNow",
      trigger: "manual",
      message: "scheduler blew up",
      extensionVersion: extensionVersion(),
      platform: process.platform,
    });
    expect(options).toMatchObject({ title: "Sync failed: scheduler blew up" });
  });

  it("does not duplicate debug toast when delegating to push failure", async () => {
    determineSyncActionMock.mockResolvedValue({ action: "push" });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.includes("/gists") && method === "GET") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [],
        } as Response;
      }

      if (url.includes("/gists") && method === "POST") {
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ message: "Internal Server Error" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "validateStoredToken").mockResolvedValue(true);
    vi.spyOn(auth, "requireToken").mockResolvedValue("ghp_test_token");

    const diagnostics = await import("../src/diagnostics.js");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    vi.spyOn(diagnostics, "addSyncHistoryEntry").mockResolvedValue(undefined);

    const paths = await import("../src/paths.js");
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([]);
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({
      cursorUser: "/tmp/cursor-user",
      dotCursor: "/tmp/.cursor",
    });

    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow(mockContext());

    expect(showSyncFailureWithDebugMock).toHaveBeenCalledTimes(1);
    const [, failure] = showSyncFailureWithDebugMock.mock.calls[0]!;
    expect(failure).toMatchObject({ operation: "push", direction: "push" });
  });
});
