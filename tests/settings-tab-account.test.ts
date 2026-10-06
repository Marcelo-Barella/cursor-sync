import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
}));

import { renderSettingsAccountSection } from "../src/sidebar/settings-tab.js";

describe("renderSettingsAccountSection", () => {
  it("shows login actions when signed out", () => {
    const html = renderSettingsAccountSection({ appSessionActive: false });
    expect(html).toContain('data-command="loginToApp"');
    expect(html).toContain('data-command="enterAppAuthCode"');
    expect(html).not.toContain('data-command="appLogout"');
  });

  it("shows email and logout when signed in", () => {
    const html = renderSettingsAccountSection({
      appSessionActive: true,
      appSessionEmail: "user@example.com",
    });
    expect(html).toContain("user@example.com");
    expect(html).toContain('data-command="appLogout"');
    expect(html).not.toContain('data-command="loginToApp"');
  });
});
