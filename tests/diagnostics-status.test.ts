import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { buildStatusQuickPickItems } from "../src/diagnostics.js";
import type { SyncHistoryEntry } from "../src/types.js";

describe("buildStatusQuickPickItems", () => {
  it("includes Cursor Sync storage history when present", () => {
    const items = buildStatusQuickPickItems(undefined, [
      {
        timestamp: "2026-06-01T12:00:00.000Z",
        direction: "push",
        trigger: "manual",
        fileCount: 8,
        success: true,
        destination: "cursor-sync-storage",
      },
    ]);

    const labels = items.map((item) => item.label);
    expect(labels.some((label) => label.includes("Cursor Sync storage"))).toBe(true);
    const storageLine = items.find((item) => item.label.startsWith("Cursor Sync storage — last"));
    expect(storageLine?.description).toContain("succeeded");
  });

  it("uses derived presentation for held storage (not raw failed label)", () => {
    const history: SyncHistoryEntry[] = [
      {
        timestamp: "2026-06-02T00:00:00.000Z",
        direction: "push",
        trigger: "scheduled",
        fileCount: 1,
        success: true,
        destination: "cursor-sync-storage",
      },
      {
        timestamp: "2026-06-01T12:00:00.000Z",
        direction: "pull",
        trigger: "scheduled",
        fileCount: 0,
        success: false,
        held: true,
        destination: "cursor-sync-storage",
        error: "held: root blocked",
      },
    ];
    const items = buildStatusQuickPickItems(undefined, history, {
      activeHeldFingerprint: "blocked:root",
    });
    const statusLine = items.find((item) => item.label === "Cursor Sync storage — status");
    expect(statusLine?.description).toContain("Storage pull held");
    expect(statusLine?.description).not.toContain("failed");
  });

  it("last direction line matches derived held state (not raw succeeded)", () => {
    const history: SyncHistoryEntry[] = [
      {
        timestamp: "2026-06-02T00:00:00.000Z",
        direction: "push",
        trigger: "scheduled",
        fileCount: 1,
        success: true,
        destination: "cursor-sync-storage",
      },
      {
        timestamp: "2026-06-01T12:00:00.000Z",
        direction: "pull",
        trigger: "scheduled",
        fileCount: 0,
        success: false,
        held: true,
        destination: "cursor-sync-storage",
        error: "held: root blocked",
      },
    ];
    const items = buildStatusQuickPickItems(undefined, history, {
      activeHeldFingerprint: "blocked:root",
    });
    const lastLine = items.find((item) =>
      item.label.startsWith("Cursor Sync storage — last")
    );
    expect(lastLine?.description).toContain("last push: held");
    expect(lastLine?.description).not.toContain("succeeded");
  });

  it("uses derived presentation for partial storage", () => {
    const history: SyncHistoryEntry[] = [
      {
        timestamp: "2026-06-01T12:00:00.000Z",
        direction: "pull",
        trigger: "manual",
        fileCount: 2,
        success: false,
        partial: true,
        destination: "cursor-sync-storage",
      },
    ];
    const items = buildStatusQuickPickItems(undefined, history);
    const statusLine = items.find((item) => item.label === "Cursor Sync storage — status");
    expect(statusLine?.description).toContain("partial");
  });
});
