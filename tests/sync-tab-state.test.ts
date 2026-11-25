import { describe, expect, it } from "vitest";
import { buildSyncTabStateFromInputs } from "../src/sidebar/sync-tab-state.js";

describe("sync tab status card from storage history", () => {
  it("shows synced state from latest cursor-sync-storage attempt when logged in", () => {
    const state = buildSyncTabStateFromInputs({
      history: [
        {
          timestamp: "2026-06-01T12:00:00.000Z",
          direction: "push",
          trigger: "manual",
          fileCount: 4,
          success: true,
          destination: "cursor-sync-storage",
        },
      ],
      appSessionActive: true,
      isSyncOperationActive: false,
    });

    expect(state.status).toBe("synced");
    expect(state.lastSyncTime).toBe("2026-06-01T12:00:00.000Z");
    expect(state.lastSyncDirection).toBe("push");
    expect(state.fileCount).toBe(4);
    expect(state.statusDetail).toContain("succeeded");
  });

  it("shows error when latest storage attempt failed", () => {
    const state = buildSyncTabStateFromInputs({
      history: [
        {
          timestamp: "2026-06-01T13:00:00.000Z",
          direction: "pull",
          trigger: "manual",
          fileCount: 0,
          success: false,
          destination: "cursor-sync-storage",
          error: "auth",
        },
      ],
      appSessionActive: true,
      isSyncOperationActive: false,
    });

    expect(state.status).toBe("error");
    expect(state.lastSyncDirection).toBe("pull");
    expect(state.statusDetail).toContain("failed");
  });
});
