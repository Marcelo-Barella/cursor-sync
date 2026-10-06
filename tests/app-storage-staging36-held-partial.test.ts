import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
const executePullMock = vi.hoisted(() => vi.fn());
const executePushMock = vi.hoisted(() => vi.fn());
const refreshSyncStatusBarMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/app-auth.js", () => ({ getAppSession: vi.fn().mockResolvedValue("jwt") }));
vi.mock("../src/app-configs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-configs.js")>();
  return {
    ...actual,
    determineAppStorageSyncAction: vi.fn().mockResolvedValue({
      action: "pull-push",
      pullKeys: ["k"],
      pushKeys: ["k"],
    }),
    hasAppSession: vi.fn().mockResolvedValue(true),
    executePullAppConfigs: vi.fn().mockResolvedValue("partial"),
  };
});
vi.mock("../src/pull.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pull.js")>();
  return { ...actual, executePull: executePullMock };
});
vi.mock("../src/push.js", () => ({ executePush: executePushMock }));
vi.mock("../src/sync-operation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-operation.js")>();
  return { ...actual, isSyncOperationActive: () => false, tryBeginSyncOperation: () => true, resetSyncOperation: vi.fn(), recoverSyncOperationLatch: vi.fn() };
});
vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({ appendLine: vi.fn() }),
    loadSyncState: vi.fn(),
    recordStorageSyncRecovery: vi.fn(),
    loadSyncHistory: vi.fn().mockResolvedValue([
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        direction: "pull",
        trigger: "manual",
        fileCount: 1,
        success: false,
        partial: true,
        destination: "cursor-sync-storage",
      },
    ]),
  };
});
vi.mock("../src/analytics.js", () => ({ sendEvent: vi.fn() }));
vi.mock("../src/sync-status-bar.js", () => ({ refreshSyncStatusBar: refreshSyncStatusBarMock }));
vi.mock("../src/sidebar/index.js", () => ({ refreshSidebar: vi.fn() }));
vi.mock("../src/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scheduler.js")>();
  return { ...actual, determineSyncAction: vi.fn() };
});

describe("staging.36 held/partial routing", () => {
  beforeEach(() => {
    vi.resetModules();
    executePullMock.mockReset();
    executePushMock.mockReset();
    refreshSyncStatusBarMock.mockClear();
  });

  it("scheduler pull-push does not push after held", async () => {
    executePullMock.mockResolvedValue({ status: "held" });
    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(executePushMock).not.toHaveBeenCalled();
  });

  it("scheduler pull-push does not push after partial", async () => {
    executePullMock.mockResolvedValue({ status: "partial" });
    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(executePushMock).not.toHaveBeenCalled();
  });

  it("Sync Now does not push when pull returns partial", async () => {
    executePullMock.mockResolvedValue({ status: "partial" });
    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(executePushMock).not.toHaveBeenCalled();
  });

});
