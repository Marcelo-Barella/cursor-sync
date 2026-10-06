import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const executePushAppConfigsMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const executePullAppConfigsMock = vi.hoisted(() => vi.fn().mockResolvedValue("success"));
const hasAppSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(false));

vi.mock("../src/app-configs.js", () => ({
  hasAppSession: hasAppSessionMock,
  executePushAppConfigs: executePushAppConfigsMock,
  executePullAppConfigs: executePullAppConfigsMock,
}));

vi.mock("../src/auth.js", () => ({
  validateStoredToken: () => {
    throw new Error("Gist push path should not run when app session is active");
  },
  requireToken: async () => undefined,
}));

vi.mock("../src/sync-operation.js", () => ({
  tryBeginSyncOperation: () => true,
  resetSyncOperation: () => {},
}));

vi.mock("../src/statusbar.js", () => ({
  updateStatusBar: vi.fn(),
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: vi.fn(),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn() }),
  loadSyncState: async () => undefined,
}));

vi.mock("vscode", () => ({
  window: { showWarningMessage: vi.fn() },
}));

function makeContext(): vscode.ExtensionContext {
  return { secrets: {} } as unknown as vscode.ExtensionContext;
}

describe("executePush app session routing", () => {
  beforeEach(() => {
    vi.resetModules();
    hasAppSessionMock.mockReset().mockResolvedValue(false);
    executePushAppConfigsMock.mockReset().mockResolvedValue(true);
  });

  it("delegates to executePushAppConfigs when an app session exists", async () => {
    hasAppSessionMock.mockResolvedValue(true);
    const { executePush } = await import("../src/push.js");
    const ok = await executePush(makeContext(), { trigger: "manual" });
    expect(ok).toBe(true);
    expect(executePushAppConfigsMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "manual",
    });
  });
});

describe("executePull app session routing", () => {
  beforeEach(() => {
    vi.resetModules();
    hasAppSessionMock.mockReset().mockResolvedValue(false);
    executePullAppConfigsMock.mockReset().mockResolvedValue("success");
  });

  it("delegates to executePullAppConfigs when an app session exists", async () => {
    hasAppSessionMock.mockResolvedValue(true);
    const { executePull } = await import("../src/pull.js");
    const ok = await executePull(makeContext(), { trigger: "scheduled" });
    expect(ok).toEqual({ status: "success" });
    expect(executePullAppConfigsMock).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
  });
});
