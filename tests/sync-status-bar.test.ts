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

vi.mock("../src/diagnostics.js", () => ({
  loadSyncState: vi.fn().mockResolvedValue(undefined),
}));

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
  });

  it("opens app login from Setup when there is no GitHub token", async () => {
    getTokenMock.mockResolvedValue(undefined);
    const { refreshSyncStatusBar } = await import("../src/sync-status-bar.js");
    await refreshSyncStatusBar(makeContext());
    expect(updateStatusBarMock).toHaveBeenCalledWith("unconfigured", undefined, {
      setupCommand: "cursorSync.loginToApp",
    });
  });
});
