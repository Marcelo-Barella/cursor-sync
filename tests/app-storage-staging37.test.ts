import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const recordRecoveryMock = vi.hoisted(() => vi.fn());
const clearHeldMock = vi.hoisted(() => vi.fn());
const addHistoryMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/app-auth.js", () => ({ getAppSession: vi.fn().mockResolvedValue("jwt") }));
vi.mock("../src/pull.js", () => ({
  executePull: vi.fn(),
  executePullSucceeded: vi.fn(),
}));
vi.mock("../src/push.js", () => ({ executePush: vi.fn() }));
vi.mock("../src/sync-operation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-operation.js")>();
  return { ...actual, isSyncOperationActive: () => false };
});
vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({ appendLine: vi.fn() }),
    loadSyncState: vi.fn(),
    loadSyncHistory: vi.fn().mockResolvedValue([]),
    addSyncHistoryEntry: addHistoryMock,
    recordStorageSyncRecovery: recordRecoveryMock,
  };
});
vi.mock("../src/app-configs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-configs.js")>();
  return {
    ...actual,
    determineAppStorageSyncAction: vi.fn().mockResolvedValue({ action: "none" }),
    clearScheduledRootHeldMarkers: clearHeldMock,
  };
});
vi.mock("../src/analytics.js", () => ({ sendEvent: vi.fn() }));
vi.mock("../src/sync-status-bar.js", () => ({ refreshSyncStatusBar: vi.fn() }));
vi.mock("../src/sidebar/index.js", () => ({ refreshSidebar: vi.fn() }));

describe("staging.37 scheduler recovery and held markers", () => {
  beforeEach(() => {
    vi.resetModules();
    recordRecoveryMock.mockReset();
    clearHeldMock.mockReset();
    addHistoryMock.mockReset();
  });

  it("does not record storage recovery on idle none when storage was never degraded", async () => {
    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(recordRecoveryMock).not.toHaveBeenCalled();
    expect(clearHeldMock).not.toHaveBeenCalled();
  });

  it("scheduled push success does not clear held markers", async () => {
    const appConfigs = await import("../src/app-configs.js");
    vi.mocked(appConfigs.determineAppStorageSyncAction).mockResolvedValue({
      action: "push",
      keys: ["k"],
      deletions: [],
    });
    const push = await import("../src/push.js");
    vi.mocked(push.executePush).mockResolvedValue(true);

    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick({
      globalState: { get: () => "held:fp", update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(clearHeldMock).not.toHaveBeenCalled();
  });
});
