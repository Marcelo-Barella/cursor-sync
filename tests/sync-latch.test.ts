import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      inspect: () => undefined,
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

const updateStatusBarMock = vi.hoisted(() => vi.fn());
vi.mock("../src/statusbar.js", () => ({
  updateStatusBar: updateStatusBarMock,
}));

const getTokenMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/auth.js", () => ({
  getToken: getTokenMock,
}));

vi.mock("../src/diagnostics.js", () => ({
  loadSyncState: vi.fn(async () => undefined),
  getLogger: () => ({ appendLine: vi.fn() }),
}));

const refreshSidebarMock = vi.hoisted(() => vi.fn());
vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: refreshSidebarMock,
}));

describe("sync latch recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    updateStatusBarMock.mockReset();
    refreshSidebarMock.mockReset();
    getTokenMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const { resetSyncOperation } = await import("../src/sync-operation.js");
    resetSyncOperation();
  });

  it("forces release of a stuck latch so Sync Now can run again", async () => {
    const syncOp = await import("../src/sync-operation.js");
    expect(syncOp.tryBeginSyncOperation()).toBe(true);
    expect(syncOp.isSyncOperationActive()).toBe(true);

    const context = {} as import("vscode").ExtensionContext;
    await syncOp.recoverSyncOperationLatch(context, { force: true });
    expect(syncOp.isSyncOperationActive()).toBe(false);
    expect(refreshSidebarMock).toHaveBeenCalled();
  });

  it("executeSyncNow clears latch after a prior stuck lock", async () => {
    const syncOp = await import("../src/sync-operation.js");
    const startedAt = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => startedAt);
    syncOp.tryBeginSyncOperation();
    vi.spyOn(Date, "now").mockImplementation(() => startedAt + 10 * 60 * 1000 + 1);

    const determineSyncActionMock = vi.fn().mockResolvedValue({ action: "error", reason: "no_token" });
    vi.doMock("../src/scheduler.js", () => ({
      determineSyncAction: determineSyncActionMock,
      shouldSkipGistPushForAppSession: vi.fn(),
    }));

    const showSyncFailureWithDebugMock = vi.fn();
    vi.doMock("../src/sync-debug.js", () => ({
      buildSyncDebugFailure: vi.fn(),
      showSyncFailureWithDebug: showSyncFailureWithDebugMock,
    }));

    const { executeSyncNow } = await import("../src/extension.js");
    await executeSyncNow({} as import("vscode").ExtensionContext);

    expect(syncOp.isSyncOperationActive()).toBe(false);
    expect(refreshSidebarMock).toHaveBeenCalled();
  });
});
