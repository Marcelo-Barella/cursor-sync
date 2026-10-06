import { describe, expect, it } from "vitest";
import { renderSyncPane, type SyncTabState } from "../src/sidebar/sync-tab.js";

function lockedState(): SyncTabState {
  return {
    status: "not-synced",
    lastSyncTime: undefined,
    lastSyncDirection: undefined,
    fileCount: 0,
    gistId: undefined,
    history: [],
    appSessionActive: true,
    appSessionExpired: false,
    e2ePhase: "locked",
  };
}

describe("renderSyncPane locked phase", () => {
  it("keeps Sync Now, Push, and Pull clickable (not disabled)", () => {
    const html = renderSyncPane(lockedState());
    expect(html).toMatch(/data-command="syncNow"[^>]*>(?!.*disabled)/);
    expect(html).not.toMatch(/data-command="syncNow"[^>]*disabled/);
    expect(html).not.toMatch(/data-command="push"[^>]*disabled/);
    expect(html).not.toMatch(/data-command="pull"[^>]*disabled/);
  });

  it("disables actions when email is not verified", () => {
    const html = renderSyncPane({
      ...lockedState(),
      e2ePhase: "email_not_verified",
    });
    expect(html).toMatch(/data-command="syncNow"[^>]*disabled/);
    expect(html).toMatch(/data-command="push"[^>]*disabled/);
  });
});
