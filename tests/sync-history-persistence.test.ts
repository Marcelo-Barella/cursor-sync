import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  addSyncHistoryEntry,
  getSyncHistoryPath,
  loadSyncHistory,
} from "../src/diagnostics.js";
import type { SyncHistoryEntry } from "../src/types.js";

async function makeContext(): Promise<vscode.ExtensionContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-history-"));
  return {
    globalStorageUri: { fsPath: dir },
  } as vscode.ExtensionContext;
}

describe("sync-history persistence", () => {
  const contexts: vscode.ExtensionContext[] = [];

  afterEach(async () => {
    for (const ctx of contexts) {
      const fp = getSyncHistoryPath(ctx);
      try {
        await fs.rm(path.dirname(fp), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    contexts.length = 0;
  });

  it("persists partial flag on the newest storage entry", async () => {
    const ctx = await makeContext();
    contexts.push(ctx);
    const prior: SyncHistoryEntry = {
      timestamp: "2026-01-01T00:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 3,
      success: true,
      destination: "cursor-sync-storage",
    };
    await addSyncHistoryEntry(ctx, prior);
    await addSyncHistoryEntry(ctx, {
      timestamp: "2026-01-02T00:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 2,
      success: false,
      partial: true,
      destination: "cursor-sync-storage",
      error: "2 skipped",
    });

    const raw = await fs.readFile(getSyncHistoryPath(ctx), "utf8");
    const disk = JSON.parse(raw) as SyncHistoryEntry[];
    expect(disk[0]?.partial).toBe(true);
    expect(disk[0]?.success).toBe(false);
    expect(disk[1]?.partial).toBeUndefined();

    const loaded = await loadSyncHistory(ctx);
    expect(loaded[0]?.partial).toBe(true);
    expect(loaded[0]?.destination).toBe("cursor-sync-storage");
  });

  it("serializes concurrent writes without dropping entries", async () => {
    const ctx = await makeContext();
    contexts.push(ctx);
    await Promise.all([
      addSyncHistoryEntry(ctx, {
        timestamp: "2026-06-01T00:00:00.000Z",
        direction: "push",
        trigger: "manual",
        fileCount: 1,
        success: true,
        destination: "cursor-sync-storage",
      }),
      addSyncHistoryEntry(ctx, {
        timestamp: "2026-06-02T00:00:00.000Z",
        direction: "pull",
        trigger: "manual",
        fileCount: 2,
        success: false,
        partial: true,
        destination: "cursor-sync-storage",
      }),
    ]);

    const history = await loadSyncHistory(ctx);
    expect(history.length).toBe(2);
    expect(history.some((e) => e.partial === true)).toBe(true);
    expect(history.some((e) => e.direction === "push")).toBe(true);
  });
});