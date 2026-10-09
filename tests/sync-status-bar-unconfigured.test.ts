import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const updateStatusBar = vi.hoisted(() => vi.fn());
const getToken = vi.hoisted(() => vi.fn());
const hasAppSession = vi.hoisted(() => vi.fn());
const loadSyncState = vi.hoisted(() => vi.fn());
const loadSyncHistory = vi.hoisted(() => vi.fn());
const isSyncOperationActive = vi.hoisted(() => vi.fn(() => false));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/statusbar.js", () => ({ updateStatusBar }));
vi.mock("../src/auth.js", () => ({ getToken }));
vi.mock("../src/app-configs.js", () => ({ hasAppSession }));
vi.mock("../src/diagnostics.js", () => ({
  loadSyncState,
  loadSyncHistory,
}));
vi.mock("../src/sync-operation.js", () => ({ isSyncOperationActive }));

describe("refreshSyncStatusBar unconfigured command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasAppSession.mockResolvedValue(false);
    loadSyncHistory.mockResolvedValue([]);
  });

  it("opens app login when no GitHub token and no gist configured", async () => {
    getToken.mockResolvedValue(undefined);
    loadSyncState.mockResolvedValue(undefined);
    const { refreshSyncStatusBar } = await import("../src/sync-status-bar.js");
    await refreshSyncStatusBar({} as vscode.ExtensionContext);
    expect(updateStatusBar).toHaveBeenCalledWith("unconfigured", {
      unconfiguredCommand: "cursorSync.loginToApp",
    });
  });

  it("opens GitHub setup when gist is configured but token missing", async () => {
    getToken.mockResolvedValue(undefined);
    loadSyncState.mockResolvedValue({ gistId: "abc", localChecksums: {}, remoteChecksums: {} });
    const { refreshSyncStatusBar } = await import("../src/sync-status-bar.js");
    await refreshSyncStatusBar({} as vscode.ExtensionContext);
    expect(updateStatusBar).toHaveBeenCalledWith("unconfigured", {
      unconfiguredCommand: "cursorSync.configureGithub",
    });
  });
});
