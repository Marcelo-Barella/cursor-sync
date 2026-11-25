import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as analytics from "../src/analytics.js";

const { sendEvent } = analytics;

const telemetryEnabledHoisted = vi.hoisted(() => ({ value: true }));

vi.mock("vscode", () => ({
  env: {
    get isTelemetryEnabled() {
      return telemetryEnabledHoisted.value;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: () => "staging",
      inspect: () => undefined,
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
}));

describe("analytics resilience", () => {
  beforeEach(() => {
    telemetryEnabledHoisted.value = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendEvent does not throw when globalState is missing", () => {
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      subscriptions: [],
      secrets: { get: vi.fn().mockResolvedValue(undefined) },
    } as unknown as import("vscode").ExtensionContext;

    expect(() =>
      sendEvent(context, "scheduled_sync_skipped", { reason: "in_progress" })
    ).not.toThrow();
  });

  it("POSTs telemetry without Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      globalState: {
        get: vi.fn(() => "client-id"),
        update: vi.fn(),
        keys: vi.fn().mockReturnValue([]),
      },
      secrets: { get: vi.fn().mockResolvedValue("session-should-not-ship") },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    sendEvent(context, "sync_completed", { direction: "push", file_count: 1, trigger: "manual" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(context.secrets.get).not.toHaveBeenCalled();
  });

  it("does not call fetch when VS Code telemetry is disabled", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    telemetryEnabledHoisted.value = false;
    const context = {
      globalStorageUri: { fsPath: "/tmp/test" },
      globalState: {
        get: vi.fn(() => "client-id"),
        update: vi.fn(),
        keys: vi.fn().mockReturnValue([]),
      },
      secrets: { get: vi.fn() },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    sendEvent(context, "sync_completed", { direction: "push", file_count: 1, trigger: "manual" });
    expect(fetchMock).not.toHaveBeenCalled();
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
      secrets: { get: vi.fn().mockResolvedValue(undefined) },
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
      secrets: { get: vi.fn().mockResolvedValue(undefined) },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;

    await expect(scheduledTick(context)).resolves.toBeUndefined();
  });
});
