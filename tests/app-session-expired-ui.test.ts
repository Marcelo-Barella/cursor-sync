import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderAccountSection } from "../src/sidebar/sync-tab.js";

vi.mock("vscode", () => ({
  window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn(), show: vi.fn() }),
}));

const refreshSidebarMock = vi.hoisted(() => vi.fn());
const refreshStatusMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: refreshSidebarMock,
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: refreshStatusMock,
}));

vi.mock("../src/e2e/gate.js", () => ({
  onAppSessionCleared: vi.fn(),
}));

describe("markAppSessionExpired UI refresh", () => {
  beforeEach(() => {
    refreshSidebarMock.mockClear();
    refreshStatusMock.mockClear();
  });

  it("renders warning icon beside session expired copy", () => {
    const html = renderAccountSection(false, true);
    expect(html).toContain("codicon-warning");
    expect(html).toContain("Session expired, log in again");
    expect(html).toContain("account-status-expired");
  });

  it("refreshes sidebar and status bar", async () => {
    const context = {
      globalState: {
        update: vi.fn(async () => undefined),
        get: vi.fn(() => undefined),
      },
      secrets: {
        delete: vi.fn(async () => undefined),
      },
    } as unknown as import("vscode").ExtensionContext;

    const { markAppSessionExpired } = await import("../src/app-auth.js");
    await markAppSessionExpired(context);
    expect(refreshSidebarMock).toHaveBeenCalled();
    expect(refreshStatusMock).toHaveBeenCalledWith(context);
  });
});
