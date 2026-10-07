import { describe, expect, it, vi, beforeEach } from "vitest";

const mockRoots = vi.hoisted(() => ({ cursorUser: "", dotCursor: "" }));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: mockRoots.cursorUser || "/tmp/cursor-sync-pull-fallback-user",
    dotCursor: mockRoots.dotCursor || "/tmp/cursor-sync-pull-fallback-dot",
  }),
  enumerateSyncFiles: async () => [],
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
  },
}));
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  mergeUploadedKeysIntoRemotePayload,
  type AppConfigsPayloadV1,
} from "../src/app-configs.js";
import { createBackup, rollbackFromBackup } from "../src/rollback.js";
import { computeChecksum } from "../src/packaging.js";

describe("mergeUploadedKeysIntoRemotePayload", () => {
  const remote: AppConfigsPayloadV1 = {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMachineId: "m",
      sourceOS: "linux",
      files: {
        "cursor-user/a.json": { checksum: "ca", sizeBytes: 1 },
        "cursor-user/b.json": { checksum: "cb", sizeBytes: 1 },
        "cursor-user/c.json": { checksum: "cc", sizeBytes: 1 },
      },
    },
    files: {
      "cursor-user/a.json": { checksum: "ca", sizeBytes: 1 },
      "cursor-user/b.json": { checksum: "cb", sizeBytes: 1 },
      "cursor-user/c.json": { checksum: "cc", sizeBytes: 1 },
    },
  };

  const local: AppConfigsPayloadV1 = {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: "2026-01-02T00:00:00.000Z",
      sourceMachineId: "m2",
      sourceOS: "linux",
      files: {
        "cursor-user/a.json": { checksum: "ca2", sizeBytes: 2 },
        "cursor-user/b.json": { checksum: "cb2", sizeBytes: 2 },
      },
    },
    files: {
      "cursor-user/a.json": { checksum: "ca2", sizeBytes: 2 },
      "cursor-user/b.json": { checksum: "cb2", sizeBytes: 2 },
    },
  };

  it("keeps full remote key set when only some keys uploaded", () => {
    const merged = mergeUploadedKeysIntoRemotePayload(remote, local, [
      "cursor-user/a.json",
      "cursor-user/b.json",
    ]);
    expect(Object.keys(merged.manifest.files).sort()).toEqual([
      "cursor-user/a.json",
      "cursor-user/b.json",
      "cursor-user/c.json",
    ]);
    expect(merged.files["cursor-user/c.json"]?.checksum).toBe("cc");
    expect(merged.files["cursor-user/a.json"]?.checksum).toBe("ca2");
  });
});

describe("rollback backup names", () => {
  it("does not collide for paths that previously mapped to the same backup name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-backup-"));
    const ctx = { globalStorageUri: { fsPath: dir } } as never;
    const a = path.join(dir, "commands", "a", "b.md");
    const b = path.join(dir, "commands", "a--b.md");
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.writeFile(a, "one", "utf-8");
    await fs.writeFile(b, "two", "utf-8");

    const { entries } = await createBackup(ctx, [a, b]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.backupPath).not.toBe(entries[1]?.backupPath);

    await fs.writeFile(a, "changed-a", "utf-8");
    await fs.writeFile(b, "changed-b", "utf-8");
    await rollbackFromBackup(entries);
    expect(await fs.readFile(a, "utf-8")).toBe("one");
    expect(await fs.readFile(b, "utf-8")).toBe("two");
  });
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: vi.fn(),
    show: vi.fn(),
  }),
}));

describe("pull journal replay", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("replays incomplete journal on startup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-journal-"));
    const cursorUser = path.join(dir, "cursor-user");
    await fs.mkdir(cursorUser, { recursive: true });
    mockRoots.cursorUser = cursorUser;
    mockRoots.dotCursor = path.join(dir, "dot-cursor");
    const target = path.join(cursorUser, "settings.json");
    await fs.writeFile(target, "new-content", "utf-8");
    const journalId = "abcd1234567890ab";
    const storage = path.join(dir, "storage");
    const backupDir = path.join(storage, "backups", `app-config-pull-${journalId}`);
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${computeChecksum(Buffer.from("x"))}.backup`);
    await fs.writeFile(backupPath, "old-content", "utf-8");

    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;

    const { writePullJournal, replayIncompletePullJournals } = await import(
      "../src/app-config-pull-journal.js"
    );
    await writePullJournal(ctx, {
      id: journalId,
      startedAt: new Date().toISOString(),
      backupDir,
      phase: "writing",
      entries: [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          backupPath,
          createdByPull: false,
          expectedChecksum: computeChecksum(Buffer.from("old-content")),
          kind: "file",
          wroteChecksum: computeChecksum(Buffer.from("new-content")),
          renameCompleted: true,
        },
      ],
    });

    await replayIncompletePullJournals(ctx);
    expect(await fs.readFile(target, "utf-8")).toBe("old-content");
  });

  it("shows a dismissible warning when quarantining an invalid journal on replay", async () => {
    const vscode = await import("vscode");
    const showWarning = vi.mocked(vscode.window.showWarningMessage);
    showWarning.mockClear();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-journal-invalid-"));
    const cursorUser = path.join(dir, "cursor-user");
    await fs.mkdir(cursorUser, { recursive: true });
    mockRoots.cursorUser = cursorUser;
    mockRoots.dotCursor = path.join(dir, "dot-cursor");
    const storage = path.join(dir, "storage");
    const journalId = "invalid123456789a";
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;

    const { writePullJournal, replayIncompletePullJournals } = await import(
      "../src/app-config-pull-journal.js"
    );
    await writePullJournal(ctx, {
      id: journalId,
      startedAt: new Date().toISOString(),
      backupDir: path.join(storage, "backups", `app-config-pull-${journalId}`),
      phase: "writing",
      resolvedRoots: {
        cursorUser: "/wrong/root",
        dotCursor: "/wrong/dot",
        cursorUserReal: "/wrong/root",
        dotCursorReal: "/wrong/dot",
      },
      entries: [],
    });

    await replayIncompletePullJournals(ctx);
    expect(showWarning).toHaveBeenCalledWith(
      expect.stringMatching(/quarantined an app-config pull journal/i),
      "Dismiss"
    );
  });
});

describe("executeAppConfigPullWrites safety", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function makePullFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-pull-"));
    const cursorUser = path.join(root, "cursor-user");
    await fs.mkdir(cursorUser, { recursive: true });
    const storage = path.join(root, "storage");
    await fs.mkdir(storage, { recursive: true });
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;
    mockRoots.cursorUser = cursorUser;
    mockRoots.dotCursor = path.join(root, "dot-cursor");
    await fs.mkdir(mockRoots.dotCursor, { recursive: true });
    const resolved = {
      cursorUser,
      dotCursor: mockRoots.dotCursor,
      cursorUserReal: await fs.realpath(cursorUser),
      dotCursorReal: await fs.realpath(mockRoots.dotCursor),
    };
    const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");
    const run = beginAppConfigsRun("pull");
    return { root, cursorUser, ctx, resolved, run };
  }

  it("pulls nested files when intermediate parent directories are missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-pull-nested-"));
    const dotCursor = path.join(root, "dot-cursor");
    await fs.mkdir(dotCursor, { recursive: true });
    const storage = path.join(root, "storage");
    await fs.mkdir(storage, { recursive: true });
    mockRoots.cursorUser = path.join(root, "cursor-user");
    mockRoots.dotCursor = dotCursor;
    await fs.mkdir(mockRoots.cursorUser, { recursive: true });
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;
    const resolved = {
      cursorUser: mockRoots.cursorUser,
      dotCursor,
      cursorUserReal: await fs.realpath(mockRoots.cursorUser),
      dotCursorReal: await fs.realpath(dotCursor),
    };
    const target = path.join(dotCursor, "commands", "a", "b.md");
    const content = Buffer.from("# nested", "utf-8");
    const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");
    const run = beginAppConfigsRun("pull");
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    const result = await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "dot-cursor/commands/a/b.md",
          absolutePath: target,
          content,
          expectedChecksum: computeChecksum(content),
        },
        {
          syncKey: "dot-cursor/commands/newdir/new.md",
          absolutePath: path.join(dotCursor, "commands", "newdir", "new.md"),
          content: Buffer.from("# new", "utf-8"),
          expectedChecksum: computeChecksum(Buffer.from("# new", "utf-8")),
        },
      ],
      resolved
    );
    run.end();
    expect(result.failed).toHaveLength(0);
    expect(await fs.readFile(target, "utf-8")).toBe("# nested");
    expect(
      await fs.readFile(path.join(dotCursor, "commands", "newdir", "new.md"), "utf-8")
    ).toBe("# new");
  });

  it("refuses pull write when an intermediate parent path component is a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-pull-symlink-parent-"));
    const dotCursor = path.join(root, "dot-cursor");
    const outside = path.join(root, "outside");
    await fs.mkdir(dotCursor, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(dotCursor, "commands"));
    const storage = path.join(root, "storage");
    await fs.mkdir(storage, { recursive: true });
    mockRoots.cursorUser = path.join(root, "cursor-user");
    mockRoots.dotCursor = dotCursor;
    await fs.mkdir(mockRoots.cursorUser, { recursive: true });
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;
    const resolved = {
      cursorUser: mockRoots.cursorUser,
      dotCursor,
      cursorUserReal: await fs.realpath(mockRoots.cursorUser),
      dotCursorReal: await fs.realpath(dotCursor),
    };
    const target = path.join(dotCursor, "commands", "a", "b.md");
    const content = Buffer.from("blocked", "utf-8");
    const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");
    const run = beginAppConfigsRun("pull");
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    await expect(
      executeAppConfigPullWrites(
        ctx,
        run,
        [
          {
            syncKey: "dot-cursor/commands/a/b.md",
            absolutePath: target,
            content,
            expectedChecksum: computeChecksum(content),
          },
        ],
        resolved
      )
    ).rejects.toThrow(/Pull write failed/);
    run.end();
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a pre-existing unrelated .tmp file", async () => {
    const { cursorUser, ctx, resolved, run } = await makePullFixture();
    const target = path.join(cursorUser, "settings.json");
    const staleTmp = path.join(cursorUser, "settings.json.tmp");
    await fs.writeFile(staleTmp, "user-tmp", "utf-8");
    const content = Buffer.from('{"remote":true}', "utf-8");
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          content,
          expectedChecksum: computeChecksum(content),
        },
      ],
      resolved
    );
    run.end();
    expect(await fs.readFile(staleTmp, "utf-8")).toBe("user-tmp");
  });

  it("backs up and restores symlinks via rollback helper", async () => {
    const { cursorUser, ctx, resolved, run } = await makePullFixture();
    const target = path.join(cursorUser, "link.json");
    const linkTarget = path.join(cursorUser, "real.json");
    await fs.writeFile(linkTarget, "real", "utf-8");
    await fs.symlink(linkTarget, target);
    const { entries } = await createBackup(ctx, [target]);
    const content = Buffer.from("pulled", "utf-8");
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "cursor-user/link.json",
          absolutePath: target,
          content,
          expectedChecksum: computeChecksum(content),
        },
      ],
      resolved
    );
    run.end();
    expect((await fs.lstat(target)).isFile()).toBe(true);
    await rollbackFromBackup(entries);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(target)).toBe(linkTarget);
  });

  it("refuses writes outside sync root via symlinked subdir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-escape-"));
    const outside = path.join(root, "outside");
    const cursorUser = path.join(root, "cursor-user");
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(cursorUser, { recursive: true });
    const trap = path.join(cursorUser, "trap");
    await fs.symlink(outside, trap);
    const target = path.join(trap, "settings.json");
    const { assertContainedSyncPath } = await import("../src/app-config-sync-path-safety.js");
    const resolved = {
      cursorUser,
      dotCursor: path.join(root, "dot-cursor"),
      cursorUserReal: await fs.realpath(cursorUser),
      dotCursorReal: path.join(root, "dot-cursor"),
    };
    await expect(
      assertContainedSyncPath(target, "cursor-user/trap/settings.json", resolved)
    ).rejects.toThrow(/outside sync root/i);
  });

  it("keeps user edits when rolling back after concurrent change", async () => {
    const { cursorUser, ctx, resolved, run } = await makePullFixture();
    const target = path.join(cursorUser, "settings.json");
    await fs.writeFile(target, "before", "utf-8");
    const pulled = Buffer.from("pulled", "utf-8");
    const { executeAppConfigPullWrites, rollbackPullJournal } = await import(
      "../src/app-config-pull-files.js"
    );
    const backupDir = path.join(ctx.globalStorageUri.fsPath, "backups", "user-edit");
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, "settings.backup");
    await fs.copyFile(target, backupPath);
    await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          content: pulled,
          expectedChecksum: computeChecksum(pulled),
        },
      ],
      resolved
    );
    await fs.writeFile(target, "user-edited-during-pull", "utf-8");
    run.end();
    await rollbackPullJournal(ctx, {
      id: "user-edit",
      startedAt: new Date().toISOString(),
      backupDir,
      phase: "rollback",
      entries: [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          backupPath,
          createdByPull: false,
          expectedChecksum: computeChecksum(Buffer.from("before", "utf-8")),
          kind: "file",
          wroteChecksum: computeChecksum(pulled),
          renameCompleted: true,
        },
      ],
    });
    expect(await fs.readFile(target, "utf-8")).toBe("user-edited-during-pull");
  });

  it("journal entry exists before rename completes (crash-safe ordering)", async () => {
    const { cursorUser, ctx, resolved, run } = await makePullFixture();
    const target = path.join(cursorUser, "settings.json");
    const content = Buffer.from("pulled", "utf-8");
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    const { listIncompletePullJournals } = await import("../src/app-config-pull-journal.js");
    const journalMod = await import("../src/app-config-pull-journal.js");
    const originalWrite = journalMod.writePullJournal;
    let sawPendingBeforeRename = false;
    vi.spyOn(journalMod, "writePullJournal").mockImplementation(async (ctx, journal) => {
      const last = journal.entries[journal.entries.length - 1];
      if (last && last.renameCompleted === false && last.tmpPath) {
        sawPendingBeforeRename = true;
      }
      return originalWrite(ctx, journal);
    });
    await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          content,
          expectedChecksum: computeChecksum(content),
        },
      ],
      resolved
    );
    run.end();
    expect(sawPendingBeforeRename).toBe(true);
    expect(await listIncompletePullJournals(ctx)).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("post-rename chmod failure keeps file on disk and retains journal (no data-loss regression)", async () => {
    const { cursorUser, ctx, resolved, run } = await makePullFixture();
    const target = path.join(cursorUser, "settings.json");
    const content = Buffer.from("after-rename", "utf-8");
    const journalMod = await import("../src/app-config-pull-journal.js");
    const originalWrite = journalMod.writePullJournal;
    let postRenameJournalWrites = 0;
    vi.spyOn(journalMod, "writePullJournal").mockImplementation(async (c, j) => {
      const last = j.entries[j.entries.length - 1];
      if (last?.renameCompleted) {
        postRenameJournalWrites += 1;
        if (postRenameJournalWrites === 1) {
          throw new Error("journal write failed after rename");
        }
      }
      return originalWrite(c, j);
    });
    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    const { listIncompletePullJournals } = await import("../src/app-config-pull-journal.js");

    const result = await executeAppConfigPullWrites(
      ctx,
      run,
      [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          content,
          expectedChecksum: computeChecksum(content),
        },
      ],
      resolved
    );
    run.end();

    expect(await fs.readFile(target, "utf-8")).toBe("after-rename");
    const journals = await listIncompletePullJournals(ctx);
    expect(journals.length).toBe(1);
    expect(journals[0]?.entries[0]?.renameCompleted).toBe(true);
    expect(result.failed.some((line) => line.includes("post-rename held"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("rollback does not write through symlink destination pointing outside sync root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rollback-symlink-"));
    const outside = path.join(root, "outside");
    const victim = path.join(outside, "victim.json");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(victim, "victim-safe", "utf-8");
    const cursorUser = path.join(root, "cursor-user");
    await fs.mkdir(cursorUser, { recursive: true });
    mockRoots.cursorUser = cursorUser;
    mockRoots.dotCursor = path.join(root, "dot-cursor");
    const target = path.join(cursorUser, "settings.json");
    await fs.symlink(victim, target);
    const journalId = "symlinkvictim01ab";
    const storage = path.join(root, "storage");
    const backupDir = path.join(storage, "backups", `app-config-pull-${journalId}`);
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, "settings.backup");
    await fs.writeFile(backupPath, "backup-content", "utf-8");
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;
    const { rollbackPullJournal } = await import("../src/app-config-pull-files.js");
    await rollbackPullJournal(ctx, {
      id: journalId,
      startedAt: new Date().toISOString(),
      backupDir,
      phase: "rollback",
      resolvedRoots: {
        cursorUser,
        dotCursor: mockRoots.dotCursor,
        cursorUserReal: await fs.realpath(cursorUser),
        dotCursorReal: path.join(root, "dot-cursor"),
      },
      entries: [
        {
          syncKey: "cursor-user/settings.json",
          absolutePath: target,
          backupPath,
          createdByPull: false,
          expectedChecksum: computeChecksum(Buffer.from("backup-content", "utf-8")),
          kind: "file",
          wroteChecksum: computeChecksum(Buffer.from("pulled", "utf-8")),
          renameCompleted: true,
        },
      ],
    });
    expect(await fs.readFile(victim, "utf-8")).toBe("victim-safe");
  });

  it("removes only files created by the pull on abort rollback", async () => {
    const { cursorUser, ctx } = await makePullFixture();
    const journalId = "cafebabedeadbeef";
    const backupDir = path.join(
      ctx.globalStorageUri.fsPath,
      "backups",
      `app-config-pull-${journalId}`
    );
    await fs.mkdir(backupDir, { recursive: true });
    const created = path.join(cursorUser, "new-from-pull.json");
    await fs.writeFile(created, "new", "utf-8");
    const { rollbackPullJournal } = await import("../src/app-config-pull-files.js");
    await rollbackPullJournal(ctx, {
      id: journalId,
      startedAt: new Date().toISOString(),
      backupDir,
      phase: "rollback",
      entries: [
        {
          syncKey: "cursor-user/new-from-pull.json",
          absolutePath: created,
          createdByPull: true,
          expectedChecksum: "",
          kind: "file",
          wroteChecksum: computeChecksum(Buffer.from("new", "utf-8")),
          renameCompleted: true,
        },
      ],
    });
    await expect(fs.stat(created)).rejects.toThrow();
  });
});
