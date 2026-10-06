import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { formatSyncRootEnsureUserMessage, pullWriteSkipReasonFromError } from "../src/app-storage-root-errors.js";

describe("staging.35 root and write errors", () => {
  it("maps EEXIST to plain language", () => {
    expect(formatSyncRootEnsureUserMessage("EEXIST: file exists")).toContain(
      "already exists"
    );
  });

  it("maps EACCES write errors to permission_denied", () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(pullWriteSkipReasonFromError(err)).toBe("permission_denied");
  });
});

describe("staging.35 scheduler end-of-tick refresh", () => {
  const refreshMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

  vi.mock("vscode", () => import("./__mocks__/vscode.js"));
  vi.mock("../src/app-auth.js", () => ({ getAppSession: vi.fn().mockResolvedValue(null) }));
  vi.mock("../src/pull.js", () => ({ executePull: vi.fn(), executePullSucceeded: vi.fn() }));
  vi.mock("../src/push.js", () => ({ executePush: vi.fn() }));
  vi.mock("../src/sync-operation.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/sync-operation.js")>();
    return { ...actual, isSyncOperationActive: () => false };
  });
  vi.mock("../src/diagnostics.js", () => ({
    getLogger: () => ({ appendLine: vi.fn() }),
    loadSyncState: vi.fn(),
    recordStorageSyncRecovery: vi.fn(),
  }));
  vi.mock("../src/analytics.js", () => ({ sendEvent: vi.fn() }));
  vi.mock("../src/sync-debug.js", () => ({
    buildSyncDebugFailure: vi.fn(),
    showSyncFailureWithDebug: vi.fn(),
  }));
  vi.mock("../src/sync-status-bar.js", () => ({ refreshSyncStatusBar: refreshMock }));
  vi.mock("../src/sidebar/index.js", () => ({ refreshSidebar: vi.fn() }));

  beforeEach(() => {
    refreshMock.mockClear();
  });

  it("does not call a second refresh after error action finalizes the bar", async () => {
    const scheduler = await import("../src/scheduler.js");
    vi.spyOn(scheduler.scheduledSyncActionResolver, "determineSyncAction").mockResolvedValue({
      action: "error",
      reason: "rate_limit",
    });
    await scheduler.scheduledTick({
      globalState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith(expect.anything(), { failed: true });
  });
});
