import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshSidebarMock = vi.hoisted(() => vi.fn());
const updateStatusBarMock = vi.hoisted(() => vi.fn());

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: refreshSidebarMock,
}));

vi.mock("../src/statusbar.js", () => ({
  updateStatusBar: updateStatusBarMock,
}));

vi.mock("../src/auth.js", () => ({
  clearToken: vi.fn(async () => {}),
  getToken: vi.fn(async () => undefined),
}));

vi.mock("../src/app-auth.js", () => ({
  clearAppSession: vi.fn(async () => {}),
  clearPersistedAuthHandoff: vi.fn(async () => {}),
}));

vi.mock("../src/diagnostics.js", () => ({
  clearSyncState: vi.fn(async () => {}),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  clearAllStoredDeks: vi.fn(async () => {}),
}));

vi.mock("../src/e2e/migration.js", () => ({
  clearMigrationState: vi.fn(async () => {}),
}));

vi.mock("../src/e2e/gate.js", () => ({
  onAppSessionCleared: vi.fn(),
  refreshE2eGateContext: vi.fn(async () => ({ phase: "no_app_session" })),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      update: async () => {},
    }),
  },
  window: {
    showWarningMessage: async () => "Reset",
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(async () => {}),
  },
  ConfigurationTarget: { Global: 1 },
}));

describe("executeReset", () => {
  beforeEach(() => {
    vi.resetModules();
    refreshSidebarMock.mockReset();
    updateStatusBarMock.mockReset();
  });

  it("releases stuck sync operation latch", async () => {
    const syncOp = await import("../src/sync-operation.js");
    syncOp.tryBeginSyncOperation();
    expect(syncOp.isSyncOperationActive()).toBe(true);

    const { executeReset } = await import("../src/reset.js");
    await executeReset({ globalState: { get: () => undefined, update: async () => {} } } as never);

    expect(syncOp.isSyncOperationActive()).toBe(false);
    expect(refreshSidebarMock).toHaveBeenCalled();
  });
});
