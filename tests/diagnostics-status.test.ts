import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { buildStatusQuickPickItems } from "../src/diagnostics.js";

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
    expect(labels).toContain("Cursor Sync storage — files");
  });
});
