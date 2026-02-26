import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

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
      expect(syncKeyToGistFileName("dot-cursor/skills/coding/SKILL.md")).toBe(
        "dot-cursor--skills--coding--SKILL.md"
      );
    });

    it("converts double dashes back to slashes", async () => {
      const { gistFileNameToSyncKey } = await import("../src/paths.js");
      expect(gistFileNameToSyncKey("cursor-user--settings.json")).toBe(
        "cursor-user/settings.json"
      );
      expect(gistFileNameToSyncKey("dot-cursor--skills--coding--SKILL.md")).toBe(
        "dot-cursor/skills/coding/SKILL.md"
      );
    });
  });

  describe("enumerateSyncFiles", () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-paths-" + Date.now());

    beforeEach(async () => {
      const cursorUser = path.join(tmpDir, "cursorUser");
      const dotCursor = path.join(tmpDir, "dotCursor");

      await fs.mkdir(path.join(cursorUser, "snippets"), { recursive: true });
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
      await fs.writeFile(
        path.join(dotCursor, "rules", "test.mdc"),
        "rule"
      );
      await fs.writeFile(
        path.join(dotCursor, "skills", "coding", "SKILL.md"),
        "skill"
      );
      await fs.writeFile(
        path.join(dotCursor, "extensions", "ext.json"),
        "{}"
      );
      await fs.writeFile(path.join(dotCursor, "logs", "app.log"), "log");
    });

    afterEach(async () => {
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
      expect(keys).toContain("dot-cursor/rules/test.mdc");
      expect(keys).toContain("dot-cursor/skills/coding/SKILL.md");

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
  });
});
