import { beforeEach, describe, expect, it, vi } from "vitest";

const executePushMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const isPushLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const isPullLockedMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
const getAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

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
    isPushLockedMock.mockReturnValue(false);
    isPullLockedMock.mockReturnValue(false);
  });

  it("routes scheduled push through executePush when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(
      scheduler.scheduledAppStorageSyncActionResolver,
      "determineAppStorageSyncAction"
    ).mockResolvedValue({ action: "push" });

    await scheduler.scheduledTick(mockContext());

    expect(executePushMock).toHaveBeenCalled();
  });

  it("routes scheduled pull-push through executePull and executePush when app session is active", async () => {
    getAppSessionMock.mockResolvedValue("jwt-session");
    executePullMock.mockResolvedValue(true);
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(
      scheduler.scheduledAppStorageSyncActionResolver,
      "determineAppStorageSyncAction"
    ).mockResolvedValue({ action: "pull-push" });

    await scheduler.scheduledTick(mockContext());

    expect(executePullMock).toHaveBeenCalled();
    expect(executePushMock).toHaveBeenCalled();
  });
});
