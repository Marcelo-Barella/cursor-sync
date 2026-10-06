import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

describe("logout drain aborts active app-config run", () => {
  afterEach(async () => {
    const { __resetAppSessionCoordinationForTests } = await import(
      "../src/app-session-coordination.js"
    );
    __resetAppSessionCoordinationForTests();
  });

  it("aborts the active run signal when logout drain starts", async () => {
    const { beginAppConfigsRun, waitForAppConfigsLogoutDrain } = await import(
      "../src/app-session-coordination.js"
    );
    const run = beginAppConfigsRun("pull");
    expect(run.signal.aborted).toBe(false);

    const drain = waitForAppConfigsLogoutDrain();
    expect(run.signal.aborted).toBe(true);
    run.end();
    await drain;
  });

  it("logout drain invokes AbortController.abort on the active run", async () => {
    const abortCalls: AbortController[] = [];
    const originalAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function (this: AbortController, ...args: [] | [reason?: unknown]) {
      abortCalls.push(this);
      return originalAbort.apply(this, args);
    };
    try {
      const { beginAppConfigsRun, waitForAppConfigsLogoutDrain } = await import(
        "../src/app-session-coordination.js"
      );
      const run = beginAppConfigsRun("pull");
      const drain = waitForAppConfigsLogoutDrain();
      expect(abortCalls.length).toBeGreaterThan(0);
      expect(run.signal.aborted).toBe(true);
      run.end();
      await drain;
    } finally {
      AbortController.prototype.abort = originalAbort;
    }
    const { __resetAppSessionCoordinationForTests } = await import(
      "../src/app-session-coordination.js"
    );
    __resetAppSessionCoordinationForTests();
  });
});
