import { describe, expect, it, vi, beforeEach } from "vitest";

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
    const target = path.join(dir, "settings.json");
    await fs.writeFile(target, "new-content", "utf-8");
    const backupDir = path.join(dir, "backup");
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, "settings.backup");
    await fs.writeFile(backupPath, "old-content", "utf-8");

    const ctx = {
      globalStorageUri: { fsPath: path.join(dir, "storage") },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;

    const { writePullJournal, replayIncompletePullJournals } = await import(
      "../src/app-config-pull-journal.js"
    );
    await writePullJournal(ctx, {
      id: "journal1",
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
        },
      ],
    });

    await replayIncompletePullJournals(ctx);
    expect(await fs.readFile(target, "utf-8")).toBe("old-content");
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
    const resolved = {
      cursorUser,
      dotCursor: path.join(root, "dot-cursor"),
      cursorUserReal: await fs.realpath(cursorUser),
      dotCursorReal: path.join(root, "dot-cursor"),
    };
    const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");
    const run = beginAppConfigsRun("pull");
    return { root, cursorUser, ctx, resolved, run };
  }

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
        },
      ],
    });
    expect(await fs.readFile(target, "utf-8")).toBe("user-edited-during-pull");
  });

  it("removes only files created by the pull on abort rollback", async () => {
    const { cursorUser, ctx } = await makePullFixture();
    const created = path.join(cursorUser, "new-from-pull.json");
    await fs.writeFile(created, "new", "utf-8");
    const { rollbackPullJournal } = await import("../src/app-config-pull-files.js");
    await rollbackPullJournal(ctx, {
      id: "created",
      startedAt: new Date().toISOString(),
      backupDir: path.join(ctx.globalStorageUri.fsPath, "backups", "created"),
      phase: "rollback",
      entries: [
        {
          syncKey: "cursor-user/new-from-pull.json",
          absolutePath: created,
          createdByPull: true,
          expectedChecksum: "",
          kind: "file",
          wroteChecksum: computeChecksum(Buffer.from("new", "utf-8")),
        },
      ],
    });
    await expect(fs.stat(created)).rejects.toThrow();
  });
});
