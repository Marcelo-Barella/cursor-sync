import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const updateStatusBarMock = vi.hoisted(() => vi.fn());
const getTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../src/statusbar.js", () => ({
  updateStatusBar: updateStatusBarMock,
}));

vi.mock("../src/auth.js", () => ({
  getToken: getTokenMock,
}));

const loadSyncHistoryMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const hasAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock("../src/app-configs.js", () => ({
  hasAppSession: hasAppSessionMock,
}));

vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    loadSyncState: vi.fn().mockResolvedValue(undefined),
    loadSyncHistory: loadSyncHistoryMock,
  };
});

vi.mock("../src/storage-sync-ui-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage-sync-ui-status.js")>();
  return {
    ...actual,
    activeScheduledRootHeldFingerprint: () => undefined,
  };
});

vi.mock("../src/sync-operation.js", () => ({
  isSyncOperationActive: () => false,
}));

function makeContext(): vscode.ExtensionContext {
  return {} as vscode.ExtensionContext;
}

describe("refreshSyncStatusBar unconfigured command", () => {
  beforeEach(() => {
    updateStatusBarMock.mockReset();
    getTokenMock.mockReset();
    hasAppSessionMock.mockReset().mockResolvedValue(false);
    loadSyncHistoryMock.mockReset().mockResolvedValue([]);
  });

  it("uses held detail in tooltip when refresh passes held override", async () => {
    hasAppSessionMock.mockResolvedValue(true);
    loadSyncHistoryMock.mockResolvedValue([
      {
        timestamp: "2026-06-01T12:00:00.000Z",
        direction: "push",
        trigger: "manual",
        fileCount: 3,
        success: true,
        destination: "cursor-sync-storage",
      },
    ]);
    const { refreshSyncStatusBar } = await import("../src/sync-status-bar.js");
    await refreshSyncStatusBar(makeContext(), { held: true });
    expect(updateStatusBarMock).toHaveBeenCalledWith(
      "warning",
      expect.objectContaining({
        destination: "cursor-sync-storage",
        detail: expect.stringMatching(/held/i),
      })
    );
  });

  it("opens app login from Setup when there is no GitHub token", async () => {
    getTokenMock.mockResolvedValue(undefined);
    const { refreshSyncStatusBar } = await import("../src/sync-status-bar.js");
    await refreshSyncStatusBar(makeContext());
    expect(updateStatusBarMock).toHaveBeenCalledWith("unconfigured", {
      unconfiguredCommand: "cursorSync.loginToApp",
    });
  });
});
