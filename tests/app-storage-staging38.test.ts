import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { SCHEDULED_ROOT_HELD_HISTORY_KEY } from "../src/storage-sync-ui-status.js";

const clearHeldMock = vi.hoisted(() => vi.fn());
const rootsHealthyMock = vi.hoisted(() => vi.fn());
const refreshBarMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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
    loadSyncHistory: vi.fn().mockResolvedValue([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "pull",
        trigger: "scheduled",
        fileCount: 0,
        success: false,
        held: true,
        destination: "cursor-sync-storage",
        error: "held: sync root blocked",
      },
    ]),
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
vi.mock("../src/app-config-local-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-local-scan.js")>();
  return {
    ...actual,
    appStorageSyncRootsHealthyForHeldRecovery: rootsHealthyMock,
  };
});
vi.mock("../src/analytics.js", () => ({ sendEvent: vi.fn() }));
vi.mock("../src/sync-status-bar.js", () => ({ refreshSyncStatusBar: refreshBarMock }));
vi.mock("../src/sidebar/index.js", () => ({ refreshSidebar: vi.fn() }));

describe("staging.38 none tick with held fingerprint", () => {
  beforeEach(() => {
    vi.resetModules();
    clearHeldMock.mockReset();
    rootsHealthyMock.mockReset().mockResolvedValue(false);
    refreshBarMock.mockClear();
  });

  it("keeps held markers when roots are still unhealthy on none", async () => {
    const store: Record<string, unknown> = {
      [SCHEDULED_ROOT_HELD_HISTORY_KEY]: "root-held:cursor-user/",
    };
    const ctx = {
      globalState: {
        get: (key: string) => store[key],
        update: async (key: string, value: unknown) => {
          store[key] = value;
        },
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const { scheduledTick } = await import("../src/scheduler.js");
    await scheduledTick(ctx);

    expect(clearHeldMock).not.toHaveBeenCalled();
    expect(store[SCHEDULED_ROOT_HELD_HISTORY_KEY]).toBe("root-held:cursor-user/");
    expect(refreshBarMock).toHaveBeenCalled();
  });
});
