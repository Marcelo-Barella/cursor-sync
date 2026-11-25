import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => defaultValue,
    }),
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));

describe("logout gating", () => {
  afterEach(async () => {
    const { __resetAppSessionCoordinationForTests } = await import(
      "../src/app-session-coordination.js"
    );
    __resetAppSessionCoordinationForTests();
  });

  it("blocks beginAppConfigsRun while logging out", async () => {
    const { setLoggingOut, beginAppConfigsRun, LoggingOutError } = await import(
      "../src/app-session-coordination.js"
    );
    setLoggingOut(true);
    expect(() => beginAppConfigsRun("push")).toThrow(LoggingOutError);
  });
});
