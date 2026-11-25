// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

const executePushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullMock = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "success" }));
const isSyncOperationActiveMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const getAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("../src/push.js", () => ({
  executePush: executePushMock,
}));

vi.mock("../src/pull.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pull.js")>();
  return {
    ...actual,
    executePull: executePullMock,
  };
});

vi.mock("../src/sync-operation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-operation.js")>();
  return {
    ...actual,
    isSyncOperationActive: isSyncOperationActiveMock,
  };
});

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
    }),
  };
});

function mockContext(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-test" },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

describe("scheduler app session routing", () => {
  beforeEach(() => {
    executePushMock.mockClear();
    executePullMock.mockClear();
    getAppSessionMock.mockReset().mockResolvedValue(undefined);
    isSyncOperationActiveMock.mockReturnValue(false);
  });

  it("routes scheduled push through executePush when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(
      scheduler.scheduledAppStorageSyncActionResolver,
      "determineAppStorageSyncAction"
    ).mockResolvedValue({
      action: "push",
      keys: ["cursor-user/settings.json"],
      deletions: ["dot-cursor/removed.md"],
    });

    await scheduler.scheduledTick(mockContext());

    expect(executePushMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trigger: "scheduled",
        deletions: ["dot-cursor/removed.md"],
      })
    );
  });

  it("routes scheduled pull-push through executePull and executePush when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    executePullMock.mockResolvedValue({ status: "success" });
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(
      scheduler.scheduledAppStorageSyncActionResolver,
      "determineAppStorageSyncAction"
    ).mockResolvedValue({
      action: "pull-push",
      pullKeys: [],
      remoteDeletions: [],
      pushKeys: ["cursor-user/settings.json"],
      deletions: ["dot-cursor/removed.md"],
    });

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalled();
    expect(executePushMock).toHaveBeenCalled();
  });
});
