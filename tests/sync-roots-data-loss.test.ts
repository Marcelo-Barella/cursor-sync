import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

function makeContext(userDataDir: string): vscode.ExtensionContext {
  const globalStorage = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "MarceloBarella.cursor-sync"
  );
  return {
    globalStorageUri: { fsPath: globalStorage },
  } as vscode.ExtensionContext;
}

describe("sync roots decoy XDG vs user-data-dir", () => {
  let tmpRoot: string;
  let priorXdg: string | undefined;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `cursor-sync-data-loss-${Date.now()}-${Math.random()}`);
    priorXdg = process.env["XDG_CONFIG_HOME"];
    await fs.mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    if (priorXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = priorXdg;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("push enumeration and pull write paths use the same cursorUser from context, not decoy XDG", async () => {
    const userDataDir = path.join(tmpRoot, "ud");
    const decoyConfig = path.join(tmpRoot, "decoy-xdg");
    const realUser = path.join(userDataDir, "User");
    const decoyCursorUser = path.join(decoyConfig, "Cursor", "User");

    process.env["XDG_CONFIG_HOME"] = decoyConfig;

    await fs.mkdir(path.join(decoyCursorUser, "snippets"), { recursive: true });
    await fs.writeFile(
      path.join(decoyCursorUser, "settings.json"),
      '{"from":"decoy-xdg"}',
      "utf-8"
    );
    await fs.writeFile(
      path.join(decoyCursorUser, "keybindings.json"),
      '[]',
      "utf-8"
    );

    await fs.mkdir(path.join(realUser, "snippets"), { recursive: true });
    await fs.writeFile(
      path.join(realUser, "settings.json"),
      '{"from":"user-data-dir"}',
      "utf-8"
    );
    await fs.writeFile(path.join(realUser, "keybindings.json"), '[{"key":"a"}]', "utf-8");
    await fs.writeFile(path.join(realUser, "extensions.json"), "[]", "utf-8");
    await fs.writeFile(
      path.join(realUser, "snippets", "sample.code-snippets"),
      "{}",
      "utf-8"
    );

    const context = makeContext(userDataDir);
    const { enumerateSyncFiles, resolveSyncRoots } = await import("../src/paths.js");
    const roots = resolveSyncRoots("linux", context);

    expect(roots.cursorUser).toBe(realUser);
    expect(roots.cursorUser).not.toBe(decoyCursorUser);

    const files = await enumerateSyncFiles(context, roots);
    const settings = files.find((f) => f.relativeSyncKey === "cursor-user/settings.json");
    const keybindings = files.find((f) => f.relativeSyncKey === "cursor-user/keybindings.json");
    const extensions = files.find((f) => f.relativeSyncKey === "cursor-user/extensions.json");

    expect(settings?.absolutePath).toBe(path.join(realUser, "settings.json"));
    expect(keybindings?.absolutePath).toBe(path.join(realUser, "keybindings.json"));
    expect(extensions?.absolutePath).toBe(path.join(realUser, "extensions.json"));

    const settingsBuf = await fs.readFile(settings!.absolutePath, "utf-8");
    expect(settingsBuf).toContain("user-data-dir");
    expect(settingsBuf).not.toContain("decoy-xdg");

    const pullTarget = path.join(roots.cursorUser, "settings.json");
    expect(pullTarget).toBe(path.join(realUser, "settings.json"));
    await fs.writeFile(pullTarget, '{"from":"remote-pull"}', "utf-8");
    const decoyAfter = await fs.readFile(path.join(decoyCursorUser, "settings.json"), "utf-8");
    expect(decoyAfter).toContain("decoy-xdg");
    const realAfter = await fs.readFile(pullTarget, "utf-8");
    expect(realAfter).toContain("remote-pull");
  });
});
