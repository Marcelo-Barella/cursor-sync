import { describe, expect, it } from "vitest";
import { renderAccountSection } from "../src/sidebar/sync-tab.js";

describe("renderAccountSection", () => {
  it("shows login actions when app session is inactive", () => {
    const html = renderAccountSection(false);
    expect(html).toContain('data-command="loginToApp"');
    expect(html).toContain('data-command="enterAppAuthCode"');
    expect(html).not.toContain("Logged in to Cursor Sync");
  });

  it("shows logged-in account state when app session is active", () => {
    const html = renderAccountSection(true);
    expect(html).toContain("Logged in to Cursor Sync");
    expect(html).not.toContain('data-command="loginToApp"');
    expect(html).not.toContain('data-command="enterAppAuthCode"');
    expect(html).toContain('data-command="configure"');
  });
});
