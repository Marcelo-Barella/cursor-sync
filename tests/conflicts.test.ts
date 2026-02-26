import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("conflicts", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-conflicts-" + Date.now());
  const storageDir = path.join(tmpDir, "storage");

  function makeContext() {
    return {
      globalStorageUri: { fsPath: storageDir },
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => ({ dispose: () => {} }),
      },
      subscriptions: [],
    } as unknown as import("vscode").ExtensionContext;
  }

  beforeEach(async () => {
    await fs.mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    vi.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects no conflicts when sync state is absent", async () => {
    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();
    const conflicts = await detectConflicts(context, {});
    expect(conflicts).toEqual([]);
  });

  it("detects conflict when both local and remote changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";
    const localContent = "local-changed";
    const remoteContent = "remote-changed";

    await fs.writeFile(path.join(cursorUser, "settings.json"), localContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256(remoteContent),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].relativeSyncKey).toBe("cursor-user/settings.json");
  });

  it("detects no conflict when only local changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";
    const localContent = "local-changed";

    await fs.writeFile(path.join(cursorUser, "settings.json"), localContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256(originalContent),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(0);
  });

  it("detects no conflict when only remote changed", async () => {
    const cursorUser = path.join(tmpDir, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });

    const originalContent = "original";

    await fs.writeFile(path.join(cursorUser, "settings.json"), originalContent);

    const syncState = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "test-gist",
      localChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
      remoteChecksums: {
        "cursor-user/settings.json": sha256(originalContent),
      },
    };

    await fs.writeFile(
      path.join(storageDir, "sync-state.json"),
      JSON.stringify(syncState)
    );

    vi.doMock("../src/paths.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../src/paths.js")>();
      return {
        ...original,
        resolveSyncRoots: () => ({
          cursorUser,
          dotCursor: path.join(tmpDir, "dotCursor"),
        }),
        enumerateSyncFiles: async () => [
          {
            absolutePath: path.join(cursorUser, "settings.json"),
            relativeSyncKey: "cursor-user/settings.json",
          },
        ],
      };
    });

    const { detectConflicts } = await import("../src/conflicts.js");
    const context = makeContext();

    const remoteChecksums = {
      "cursor-user/settings.json": sha256("remote-changed"),
    };

    const conflicts = await detectConflicts(context, remoteChecksums);
    expect(conflicts.length).toBe(0);
  });
});
