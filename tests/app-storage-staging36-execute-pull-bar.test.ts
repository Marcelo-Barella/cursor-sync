import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { deriveStorageSyncPresentation } from "../src/storage-sync-ui-status.js";

const refreshSyncStatusBarMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/app-configs.js", () => ({
  hasAppSession: vi.fn().mockResolvedValue(true),
  executePullAppConfigs: vi.fn().mockResolvedValue("partial"),
}));
vi.mock("../src/sync-operation.js", () => ({
  tryBeginSyncOperation: () => true,
  recoverSyncOperationLatch: vi.fn(),
  resetSyncOperation: vi.fn(),
  isSyncOperationActive: () => false,
}));
vi.mock("../src/sync-status-bar.js", () => ({ refreshSyncStatusBar: refreshSyncStatusBarMock }));
vi.mock("../src/sidebar/index.js", () => ({ refreshSidebar: vi.fn() }));
vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
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

describe("staging.36 executePull bar matches deriveStorageSyncPresentation", () => {
  beforeEach(() => {
    vi.resetModules();
    refreshSyncStatusBarMock.mockClear();
  });

  it("passes warning refresh for partial app storage pulls", async () => {
    const history = [
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        direction: "pull" as const,
        trigger: "manual" as const,
        fileCount: 1,
        success: false,
        partial: true,
        destination: "cursor-sync-storage" as const,
      },
    ];
    expect(deriveStorageSyncPresentation({ history }).level).toBe("warning");

    const { executePull } = await import("../src/pull.js");
    await executePull(
      { globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext
    );
    expect(refreshSyncStatusBarMock).toHaveBeenCalledWith(expect.anything(), { warning: true });
  });
});
