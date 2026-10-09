import { describe, expect, it, vi, beforeEach } from "vitest";

const appendLineMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: { getConfiguration: () => ({ get: () => "default" }) },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: appendLineMock, show: vi.fn() }),
  loadSyncState: vi.fn(async () => undefined),
  saveSyncState: vi.fn(async () => undefined),
  addSyncHistoryEntry: vi.fn(async () => undefined),
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => undefined),
  isAppSessionExpired: vi.fn(() => true),
}));

vi.mock("../src/e2e/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/gate.js")>();
  return actual;
});

vi.mock("../src/sync-debug.js", () => ({
  buildSyncDebugFailure: vi.fn(() => ({})),
  showSyncFailureWithDebug: vi.fn(async () => undefined),
}));

vi.mock("../src/analytics.js", () => ({
  sendEvent: vi.fn(),
}));

describe("push after 401 session expiry", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockClear();
  });

  it("does not log Push started when login is required", async () => {
    const context = {
      globalState: {
        get: (key: string) =>
          key === "cursorSync.e2e.lastUserId" ? "user-1" : undefined,
        update: async () => undefined,
      },
      secrets: { get: async () => undefined },
    } as unknown as import("vscode").ExtensionContext;

    const { executePush } = await import("../src/push.js");
    const ok = await executePush(context, { skipOperationLock: true });
    expect(ok).toBe(false);
    const started = appendLineMock.mock.calls.some((args) =>
      String(args[0]).includes("Push started")
    );
    expect(started).toBe(false);
  });
});
