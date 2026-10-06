import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import {
  validatePullJournalForReplay,
  expectedBackupDirForJournal,
} from "../src/app-config-journal-validate.js";
import type { PullJournal } from "../src/app-config-pull-journal.js";

const mockRoots = vi.hoisted(() => ({
  cursorUser: "/tmp/cursor-user-jval",
  dotCursor: "/tmp/dot-cursor-jval",
}));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: mockRoots.cursorUser,
    dotCursor: mockRoots.dotCursor,
  }),
  enumerateSyncFiles: async () => [],
}));

vi.mock("../src/app-config-sync-path-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-config-sync-path-safety.js")>();
  return {
    ...actual,
    resolveSyncRootsRealpaths: async () => ({
      cursorUser: mockRoots.cursorUser,
      dotCursor: mockRoots.dotCursor,
      cursorUserReal: mockRoots.cursorUser,
      dotCursorReal: mockRoots.dotCursor,
    }),
  };
});

function ctx(storage: string) {
  return {
    globalStorageUri: { fsPath: storage },
    globalState: { get: () => undefined, update: async () => {} },
  } as never;
}

describe("validatePullJournalForReplay", () => {
  it("43roots: rejects journal when roots do not match current config", async () => {
    const storage = "/tmp/storage-jval";
    const journal: PullJournal = {
      id: "abcd1234567890ab",
      startedAt: "now",
      backupDir: expectedBackupDirForJournal(ctx(storage), "abcd1234567890ab"),
      phase: "writing",
      entries: [],
      resolvedRoots: {
        cursorUser: "/other/user",
        dotCursor: "/other/dot",
        cursorUserReal: "/other/user",
        dotCursorReal: "/other/dot",
      },
    };
    const result = await validatePullJournalForReplay(ctx(storage), journal);
    expect(result.ok).toBe(false);
  });

  it("43noroots: still validates paths against current roots", async () => {
    const storage = "/tmp/storage-jval2";
    const target = path.join(mockRoots.cursorUser, "settings.json");
    const journal: PullJournal = {
      id: "abcd1234567890ac",
      startedAt: "now",
      backupDir: expectedBackupDirForJournal(ctx(storage), "abcd1234567890ac"),
      phase: "writing",
      entries: [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          createdByPull: true,
          expectedChecksum: "x",
          kind: "file",
        },
      ],
    };
    const result = await validatePullJournalForReplay(ctx(storage), journal);
    expect(result.ok).toBe(true);
  });

  it("43bkabs: rejects absolute backup paths outside journal backup dir", async () => {
    const storage = "/tmp/storage-jval3";
    const target = path.join(mockRoots.cursorUser, "a.json");
    const journal: PullJournal = {
      id: "abcd1234567890ad",
      startedAt: "now",
      backupDir: expectedBackupDirForJournal(ctx(storage), "abcd1234567890ad"),
      phase: "writing",
      entries: [
        {
          syncKey: "cursor-user/a.json",
          absolutePath: target,
          backupPath: "/etc/passwd",
          createdByPull: false,
          expectedChecksum: "x",
          kind: "file",
        },
      ],
    };
    const result = await validatePullJournalForReplay(ctx(storage), journal);
    expect(result.ok).toBe(false);
  });
});
