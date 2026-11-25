import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
  return {
    ...actual,
    ...PATHS_MOCK_USER_LABELS,
    resolveSyncRoots: vi.fn(actual.resolveSyncRoots),
  };
});

import { resolveSyncRoots } from "../src/paths.js";
import {
  md5FolderKey,
  folderPathFromWorkspaceUri,
  resolveWorkspaceContext,
  requireWorkspaceContext,
  resolveChatsWorkspaceKey,
  buildChatsKeyToFolderMap,
} from "../src/chat-workspace-context.js";

const mockResolveSyncRoots = vi.mocked(resolveSyncRoots);

const FIXTURE_REPO = "/tmp/cursor-sync-fixture-repo";
const FIXTURE_MD5 = "573b4babd5b2f206e06d748cd840b177";

function pythonMd5FolderKey(folderFsPath: string): string {
  return createHash("md5").update(folderFsPath, "utf8").digest("hex");
}

describe("chat-workspace-context", () => {
  describe("md5FolderKey", () => {
    it("matches Python md5_folder_key for resolved absolute path", () => {
      const resolved = path.resolve(FIXTURE_REPO);
      expect(md5FolderKey(resolved)).toBe(FIXTURE_MD5);
      expect(md5FolderKey(resolved)).toBe(pythonMd5FolderKey(resolved));
    });

    it("uses UTF-8 encoding of path string (no normalization beyond caller)", () => {
      const key = md5FolderKey("/tmp/cursor-sync-fixture-repo");
      expect(key).toBe(FIXTURE_MD5);
    });
  });

  describe("folderPathFromWorkspaceUri", () => {
    it("decodes file:// URIs like Python folder_path_from_workspace_uri", () => {
      expect(folderPathFromWorkspaceUri("file:///home/user/proj")).toBe(
        "/home/user/proj"
      );
      expect(folderPathFromWorkspaceUri("file:///tmp/foo%20bar")).toBe(
        "/tmp/foo bar"
      );
    });

    it("returns raw path when not a file URI", () => {
      expect(folderPathFromWorkspaceUri("/abs/path")).toBe("/abs/path");
    });
  });

  describe("resolveWorkspaceContext", () => {
    let tempRoot: string;
    let cursorUser: string;

    beforeEach(async () => {
      tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "cursor-sync-ws-ctx-")
      );
      cursorUser = path.join(tempRoot, "Cursor", "User");
      await fs.mkdir(path.join(cursorUser, "workspaceStorage"), {
        recursive: true,
      });
      mockResolveSyncRoots.mockReturnValue({
        cursorUser,
        dotCursor: path.join(tempRoot, ".cursor"),
      });
    });

    afterEach(async () => {
      mockResolveSyncRoots.mockClear();
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it("returns null without workspace folder or resolvable state db", async () => {
      const ctx = await resolveWorkspaceContext({});
      expect(ctx).toBeNull();
    });

    it("builds chats key and workspaceIdentifier from workspace folder", async () => {
      const folder = path.join(tempRoot, "my-repo");
      await fs.mkdir(folder, { recursive: true });
      const resolved = path.resolve(folder);

      const ctx = await resolveWorkspaceContext({ workspaceFolder: folder });
      expect(ctx).not.toBeNull();
      expect(ctx!.folderFsPath).toBe(resolved);
      expect(ctx!.chatsWorkspaceKey).toBe(md5FolderKey(resolved));
      expect(ctx!.workspaceStorageId).toBe(ctx!.chatsWorkspaceKey);
      expect(ctx!.workspaceIdentifier.id).toBe(ctx!.chatsWorkspaceKey);
      expect(ctx!.workspaceIdentifier.uri.fsPath).toBe(resolved);
      expect(ctx!.workspaceIdentifier.uri.path).toBe(resolved);
      expect(ctx!.workspaceIdentifier.uri.scheme).toBe("file");
      expect(ctx!.workspaceIdentifier.uri.$mid).toBe(1);
      expect(ctx!.workspaceIdentifier.uri._sep).toBe(
        process.platform === "win32" ? 1 : 47
      );
      expect(ctx!.workspaceIdentifier.uri.external).toMatch(/^file:\/\//);
    });

    it("resolves workspaceStorage id from state.vscdb path and workspace.json", async () => {
      const folder = path.join(tempRoot, "ws-proj");
      await fs.mkdir(folder, { recursive: true });
      const storageId = "abc123storage";
      const wsDir = path.join(cursorUser, "workspaceStorage", storageId);
      await fs.mkdir(wsDir, { recursive: true });
      await fs.writeFile(
        path.join(wsDir, "workspace.json"),
        JSON.stringify({ folder: pathToFileUri(folder) }),
        "utf8"
      );
      const stateDb = path.join(wsDir, "state.vscdb");
      await fs.writeFile(stateDb, "", "utf8");

      const ctx = await resolveWorkspaceContext({ stateDbPath: stateDb });
      expect(ctx).not.toBeNull();
      expect(ctx!.workspaceStorageId).toBe(storageId);
      expect(ctx!.chatsWorkspaceKey).toBe(md5FolderKey(path.resolve(folder)));
      expect(ctx!.workspaceIdentifier.id).toBe(storageId);
    });

    it("scans workspaceStorage when only workspace folder is given", async () => {
      const folder = path.join(tempRoot, "scanned-proj");
      await fs.mkdir(folder, { recursive: true });
      const storageId = "scan-id-99";
      const wsDir = path.join(cursorUser, "workspaceStorage", storageId);
      await fs.mkdir(wsDir, { recursive: true });
      await fs.writeFile(
        path.join(wsDir, "workspace.json"),
        JSON.stringify({ folder: pathToFileUri(folder) }),
        "utf8"
      );

      const ctx = await resolveWorkspaceContext({
        workspaceFolder: folder,
      });
      expect(ctx!.workspaceStorageId).toBe(storageId);
      expect(ctx!.folderFsPath).toBe(path.resolve(folder));
      expect(ctx!.chatsWorkspaceKey).toBe(md5FolderKey(path.resolve(folder)));
      expect(ctx!.workspaceIdentifier.id).toBe(storageId);
    });

    describe("buildChatsKeyToFolderMap", () => {
      it("maps md5(folder) to resolved folder path from workspace.json entries", async () => {
        const folder = path.join(tempRoot, "mapped-repo");
        await fs.mkdir(folder, { recursive: true });
        const resolved = path.resolve(folder);
        const storageId = "map-storage-1";
        const wsDir = path.join(cursorUser, "workspaceStorage", storageId);
        await fs.mkdir(wsDir, { recursive: true });
        await fs.writeFile(
          path.join(wsDir, "workspace.json"),
          JSON.stringify({ folder: pathToFileUri(folder) }),
          "utf8"
        );
        await fs.writeFile(path.join(wsDir, "broken.json"), "not-json", "utf8");

        const map = await buildChatsKeyToFolderMap(cursorUser);
        expect(map.get(md5FolderKey(resolved))).toBe(resolved);
        expect(map.size).toBe(1);
      });
    });
  });

  describe("requireWorkspaceContext", () => {
    it("throws when context cannot be resolved", async () => {
      await expect(requireWorkspaceContext({})).rejects.toThrow(
        /Workspace folder is required/
      );
    });
  });

  describe("resolveChatsWorkspaceKey", () => {
    let tempRoot: string;
    let cursorUser: string;

    beforeEach(async () => {
      tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "cursor-sync-ws-key-")
      );
      cursorUser = path.join(tempRoot, "Cursor", "User");
      const storageId = "target-ws-id";
      const folder = path.join(tempRoot, "repo");
      await fs.mkdir(folder, { recursive: true });
      const wsDir = path.join(cursorUser, "workspaceStorage", storageId);
      await fs.mkdir(wsDir, { recursive: true });
      await fs.writeFile(
        path.join(wsDir, "workspace.json"),
        JSON.stringify({ folder: pathToFileUri(folder) }),
        "utf8"
      );
      mockResolveSyncRoots.mockReturnValue({
        cursorUser,
        dotCursor: path.join(tempRoot, ".cursor"),
      });
    });

    afterEach(async () => {
      mockResolveSyncRoots.mockClear();
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it("returns md5 chats key when workspace folder resolves", async () => {
      const folder = path.join(tempRoot, "repo");
      const { key, warnings } = await resolveChatsWorkspaceKey(
        undefined,
        undefined,
        folder,
        { storeSnapshot: null }
      );
      expect(key).toBe(md5FolderKey(path.resolve(folder)));
      expect(warnings).toEqual([]);
    });

    it("warns when target workspace is workspaceStorage id", async () => {
      const folder = path.join(tempRoot, "repo");
      const { key, warnings } = await resolveChatsWorkspaceKey(
        "target-ws-id",
        undefined,
        folder,
        { storeSnapshot: null }
      );
      expect(key).toBe(md5FolderKey(path.resolve(folder)));
      expect(warnings.some((w) => w.includes("workspaceStorage id"))).toBe(
        true
      );
    });

    it("falls back to bundle sourceWorkspaceKey when context unresolved", async () => {
      const { key, warnings } = await resolveChatsWorkspaceKey(
        undefined,
        undefined,
        undefined,
        { storeSnapshot: { sourceWorkspaceKey: "legacy-key" } }
      );
      expect(key).toBe("legacy-key");
      expect(warnings).toEqual([]);
    });

    it("returns imported when nothing resolves", async () => {
      const { key } = await resolveChatsWorkspaceKey(
        undefined,
        undefined,
        undefined,
        { storeSnapshot: null }
      );
      expect(key).toBe("imported");
    });
  });
});

function pathToFileUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}
