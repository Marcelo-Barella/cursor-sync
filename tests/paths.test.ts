import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  __resetCursorSyncInspect,
  __setCursorSyncInspect,
} from "./__mocks__/vscode.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("paths", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = { ...originalEnv };
  });

  describe("resolveSyncRoots", () => {
    it("resolves Windows paths", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      process.env["APPDATA"] = "C:\\Users\\test\\AppData\\Roaming";
      process.env["USERPROFILE"] = "C:\\Users\\test";

      const roots = resolveSyncRoots("win32");
      expect(roots.cursorUser).toBe(
        path.join("C:\\Users\\test\\AppData\\Roaming", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join("C:\\Users\\test", ".cursor"));
    });

    it("resolves macOS paths", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      const home = os.homedir();

      const roots = resolveSyncRoots("darwin");
      expect(roots.cursorUser).toBe(
        path.join(home, "Library", "Application Support", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join(home, ".cursor"));
    });

    it("resolves Linux paths with default XDG", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      delete process.env["XDG_CONFIG_HOME"];
      const home = os.homedir();

      const roots = resolveSyncRoots("linux");
      expect(roots.cursorUser).toBe(
        path.join(home, ".config", "Cursor", "User")
      );
      expect(roots.dotCursor).toBe(path.join(home, ".cursor"));
    });

    it("resolves Linux paths with custom XDG_CONFIG_HOME", async () => {
      const { resolveSyncRoots } = await import("../src/paths.js");
      process.env["XDG_CONFIG_HOME"] = "/custom/config";

      const roots = resolveSyncRoots("linux");
      expect(roots.cursorUser).toBe(
        path.join("/custom/config", "Cursor", "User")
      );
    });
  });

  describe("syncKeyToGistFileName / gistFileNameToSyncKey", () => {
    it("converts slashes to double dashes", async () => {
      const { syncKeyToGistFileName } = await import("../src/paths.js");
      expect(syncKeyToGistFileName("cursor-user/settings.json")).toBe(
        "cursor-user--settings.json"
      );
      expect(syncKeyToGistFileName("dot-cursor/skills/coding/template.txt")).toBe(
        "dot-cursor--skills--coding--template.txt"
      );
    });

    it("converts double dashes back to slashes", async () => {
      const { gistFileNameToSyncKey } = await import("../src/paths.js");
      expect(gistFileNameToSyncKey("cursor-user--settings.json")).toBe(
        "cursor-user/settings.json"
      );
      expect(gistFileNameToSyncKey("dot-cursor--skills--coding--template.txt")).toBe(
        "dot-cursor/skills/coding/template.txt"
      );
    });
  });

  describe("enumerateSyncFiles", () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-paths-" + Date.now());

    beforeEach(async () => {
      const cursorUser = path.join(tmpDir, "cursorUser");
      const dotCursor = path.join(tmpDir, "dotCursor");

      await fs.mkdir(path.join(cursorUser, "snippets"), { recursive: true });
      await fs.mkdir(path.join(cursorUser, "vsix"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "rules"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "skills", "coding"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "extensions"), { recursive: true });
      await fs.mkdir(path.join(dotCursor, "logs"), { recursive: true });

      await fs.writeFile(path.join(cursorUser, "settings.json"), "{}");
      await fs.writeFile(path.join(cursorUser, "keybindings.json"), "[]");
      await fs.writeFile(
        path.join(cursorUser, "snippets", "ts.json"),
        "{}"
      );
      await fs.writeFile(path.join(cursorUser, "vsix", "sample.vsix"), "PK\u0003\u0004");
      await fs.writeFile(
        path.join(dotCursor, "rules", "test.mdc"),
        "rule"
      );
      await fs.writeFile(
        path.join(dotCursor, "skills", "coding", "SKILL.md"),
        "skill"
      );
      await fs.writeFile(
        path.join(dotCursor, "skills", "coding", "template.txt"),
        "template"
      );
      await fs.writeFile(
        path.join(dotCursor, "extensions", "ext.json"),
        "{}"
      );
      await fs.writeFile(path.join(dotCursor, "logs", "app.log"), "log");
    });

    afterEach(async () => {
      __resetCursorSyncInspect();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("includes matching files and excludes denylisted directories", async () => {
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).toContain("cursor-user/settings.json");
      expect(keys).toContain("cursor-user/keybindings.json");
      expect(keys).toContain("cursor-user/snippets/ts.json");
      expect(keys).toContain("cursor-user/vsix/sample.vsix");
      expect(keys).toContain("dot-cursor/rules/test.mdc");
      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");
      expect(keys).toContain("dot-cursor/skills/coding/template.txt");

      expect(keys).not.toContain("dot-cursor/extensions/ext.json");
      expect(keys).not.toContain("dot-cursor/logs/app.log");
    });

    it("excludes files exceeding max size", async () => {
      const largePath = path.join(tmpDir, "cursorUser", "settings.json");
      const largeContent = Buffer.alloc(600 * 1024, "x");
      await fs.writeFile(largePath, largeContent);

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).not.toContain("cursor-user/settings.json");
    });

    it("ignores workspace excludeGlobs that would empty the push set", async () => {
      __setCursorSyncInspect({
        workspace: { excludeGlobs: ["**"] },
      });
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const keys = (await enumerateSyncFiles(roots)).map((f) => f.relativeSyncKey);
      expect(keys).toContain("cursor-user/settings.json");
      expect(keys).toContain("cursor-user/keybindings.json");
    });

    it("honors user-global excludeGlobs", async () => {
      __setCursorSyncInspect({
        global: { excludeGlobs: ["**"] },
        workspace: { excludeGlobs: [] },
      });
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const keys = (await enumerateSyncFiles(roots)).map((f) => f.relativeSyncKey);
      expect(keys).toEqual([]);
    });

    it("ignores workspace enabledPaths and maxFileSizeKB that would empty the push set", async () => {
      __setCursorSyncInspect({
        workspace: { enabledPaths: [], maxFileSizeKB: 0 },
      });
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const keys = (await enumerateSyncFiles(roots)).map((f) => f.relativeSyncKey);
      expect(keys).toContain("cursor-user/settings.json");
      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");
    });

    it("honors user-global maxFileSizeKB of 0 for non-vsix files", async () => {
      __setCursorSyncInspect({
        global: { maxFileSizeKB: 0 },
      });
      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const keys = (await enumerateSyncFiles(roots)).map((f) => f.relativeSyncKey);
      expect(keys).not.toContain("cursor-user/settings.json");
      expect(keys).toContain("cursor-user/vsix/sample.vsix");
    });

    it("allows .vsix files larger than maxFileSizeKB", async () => {
      await fs.mkdir(path.join(tmpDir, "cursorUser", "vsix"), { recursive: true });
      const vsixPath = path.join(tmpDir, "cursorUser", "vsix", "big.vsix");
      await fs.writeFile(vsixPath, Buffer.alloc(600 * 1024, "y"));

      const { enumerateSyncFiles } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join(tmpDir, "cursorUser"),
        dotCursor: path.join(tmpDir, "dotCursor"),
      };
      const files = await enumerateSyncFiles(roots);
      const keys = files.map((f) => f.relativeSyncKey);

      expect(keys).toContain("cursor-user/vsix/big.vsix");
    });
  });

  describe("syncKeyToAbsolutePath", () => {
    it("resolves keys under the matching root and rejects traversal", async () => {
      const { syncKeyToAbsolutePath } = await import("../src/paths.js");
      const roots = {
        cursorUser: path.join("/tmp", "cursor-user-root"),
        dotCursor: path.join("/tmp", "dot-cursor-root"),
      };
      expect(syncKeyToAbsolutePath("cursor-user/settings.json", roots)).toBe(
        path.resolve(roots.cursorUser, "settings.json")
      );
      expect(
        syncKeyToAbsolutePath("cursor-user/../outside.json", roots)
      ).toBeUndefined();
      expect(syncKeyToAbsolutePath("other/settings.json", roots)).toBeUndefined();
    });
  });

  describe("classifyUnselectedSyncKey", () => {
    it("classifies missing, present, and unmapped keys", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-classify-"));
      const cursorUser = path.join(tmp, "cursorUser");
      await fs.mkdir(cursorUser, { recursive: true });
      await fs.writeFile(path.join(cursorUser, "settings.json"), "{}");
      const { classifyUnselectedSyncKey } = await import("../src/paths.js");
      const roots = {
        cursorUser,
        dotCursor: path.join(tmp, "dotCursor"),
      };
      expect(
        await classifyUnselectedSyncKey("cursor-user/settings.json", roots)
      ).toBe("present-unselected");
      expect(
        await classifyUnselectedSyncKey("cursor-user/keybindings.json", roots)
      ).toBe("absent");
      expect(await classifyUnselectedSyncKey("unknown/file.json", roots)).toBe(
        "unmapped"
      );
      await fs.rm(tmp, { recursive: true, force: true });
    });
  });
});
