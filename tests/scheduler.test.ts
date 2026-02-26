import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start when schedule.enabled is false", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return false;
        if (key === "schedule.intervalMin") return 30;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);

    vi.advanceTimersByTime(120_000);
    stopScheduler();
  });

  it("enforces minimum interval of 5 minutes", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 1;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const pushModule = await import("../src/push.js");
    const pushSpy = vi.spyOn(pushModule, "executePush").mockResolvedValue(true);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);

    await vi.advanceTimersByTimeAsync(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(pushSpy).toHaveBeenCalledTimes(2);

    stopScheduler();
    pushSpy.mockRestore();
  });

  it("stops timer on stopScheduler", async () => {
    const vscode = await import("vscode");
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (key: string) => {
        if (key === "schedule.enabled") return true;
        if (key === "schedule.intervalMin") return 5;
        return undefined;
      },
      has: () => true,
      inspect: () => undefined,
      update: async () => {},
    } as ReturnType<typeof vscode.workspace.getConfiguration>);

    vi.spyOn(Math, "random").mockReturnValue(0);

    const { startScheduler, stopScheduler } = await import("../src/scheduler.js");
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    startScheduler(context);
    stopScheduler();

    vi.advanceTimersByTime(10 * 60 * 1000);
  });
});
