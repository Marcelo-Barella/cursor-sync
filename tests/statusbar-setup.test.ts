import { beforeEach, describe, expect, it, vi } from "vitest";

const statusBarItem = {
  text: "",
  tooltip: "",
  command: "",
  show: vi.fn(),
  hide: vi.fn(),
};

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: vi.fn(() => statusBarItem),
  },
  StatusBarAlignment: { Right: 1 },
}));

describe("status bar Setup command wiring", () => {
  beforeEach(() => {
    statusBarItem.command = "";
    statusBarItem.text = "";
    vi.resetModules();
  });

  it("initializeStatusBar wires Setup to app login by default", async () => {
    const { initializeStatusBar } = await import("../src/statusbar.js");
    initializeStatusBar({ subscriptions: { push: vi.fn() } } as never);
    expect(statusBarItem.command).toBe("cursorSync.loginToApp");
  });

  it("updateStatusBar unconfigured without options uses app login", async () => {
    const { initializeStatusBar, updateStatusBar } = await import("../src/statusbar.js");
    initializeStatusBar({ subscriptions: { push: vi.fn() } } as never);
    updateStatusBar("unconfigured");
    expect(statusBarItem.command).toBe("cursorSync.loginToApp");
  });

  it("updateStatusBar unconfigured honors explicit configureGithub", async () => {
    const { initializeStatusBar, updateStatusBar } = await import("../src/statusbar.js");
    initializeStatusBar({ subscriptions: { push: vi.fn() } } as never);
    updateStatusBar("unconfigured", undefined, { setupCommand: "cursorSync.configureGithub" });
    expect(statusBarItem.command).toBe("cursorSync.configureGithub");
  });
});
