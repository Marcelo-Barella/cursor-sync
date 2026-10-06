import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn().mockResolvedValue("Log out anyway"),
    showInformationMessage: vi.fn(),
  },
}));

describe("logout drain 120s prompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { __resetAppSessionCoordinationForTests } = await import(
      "../src/app-session-coordination.js"
    );
    __resetAppSessionCoordinationForTests();
  });

  it("shows force logout prompt while work is still pending", async () => {
    const vscode = await import("vscode");
    const { beginAppConfigsRun, abortAppConfigsForLogout } = await import(
      "../src/app-session-coordination.js"
    );
    const run = beginAppConfigsRun("pull");
    const drainPromise = abortAppConfigsForLogout();
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.resolve();
    await drainPromise;
    run.end();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
