import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEvent } from "../src/analytics.js";

describe("analytics resilience", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendEvent does not throw when globalState is missing", () => {
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    expect(() =>
      sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" })
    ).not.toThrow();
  });

  it("sendEvent does not throw when globalState.get or update rejects", () => {
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      globalState: {
        get: vi.fn(() => {
          throw new Error("globalState.get failed");
        }),
        update: vi.fn().mockRejectedValue(new Error("globalState.update failed")),
        keys: vi.fn().mockReturnValue([]),
      },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    expect(() =>
      sendEvent(context, "scheduled_sync_failed", { reason: "exception" })
    ).not.toThrow();
  });
});

describe("scheduledTick analytics failures", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes without rejecting when analytics globalState throws during sendEvent", async () => {
    const syncOp = await import("../src/sync-operation.js");
    vi.spyOn(syncOp, "isSyncOperationActive").mockReturnValue(true);
    const { scheduledTick } = await import("../src/scheduler.js");

    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      globalState: {
        get: vi.fn(() => {
          throw new Error("broken globalState");
        }),
        update: vi.fn().mockRejectedValue(new Error("broken update")),
        keys: vi.fn().mockReturnValue([]),
      },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    await expect(scheduledTick(context)).resolves.toBeUndefined();
  });
});
