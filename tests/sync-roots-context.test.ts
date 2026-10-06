import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

function makeContext(userDataDir: string): vscode.ExtensionContext {
  const globalStorage = path.join(userDataDir, "User", "globalStorage", "MarceloBarella.cursor-sync");
  return {
    globalStorageUri: { fsPath: globalStorage },
  } as vscode.ExtensionContext;
}

describe("sync roots from extension context", () => {
  const tmpRoot = path.join(os.tmpdir(), `cursor-sync-roots-${Date.now()}`);

  beforeEach(async () => {
    await fs.mkdir(path.join(tmpRoot, "alt-user", "User"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "alt-user", "User", "settings.json"), '{"alt":true}');
    await fs.mkdir(path.join(tmpRoot, "default-user", "User"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "default-user", "User", "settings.json"), '{"default":true}');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("enumerateSyncFiles uses cursorUser from globalStorageUri", async () => {
    const altUser = path.join(tmpRoot, "alt-user", "User");
    const context = makeContext(path.join(tmpRoot, "alt-user"));
    const { enumerateSyncFiles, resolveSyncRoots } = await import("../src/paths.js");
    const roots = resolveSyncRoots("linux", context);
    expect(roots.cursorUser).toBe(altUser);
    const files = await enumerateSyncFiles(context);
    const settings = files.find((f) => f.relativeSyncKey === "cursor-user/settings.json");
    expect(settings?.absolutePath).toBe(path.join(altUser, "settings.json"));
  });

  it("buildLocalAppConfigsPayload reads settings from the context user dir", async () => {
    const altUser = path.join(tmpRoot, "alt-user", "User");
    const context = makeContext(path.join(tmpRoot, "alt-user"));
    vi.doMock("../src/extensions.js", () => ({
      generateExtensionsJson: () => "[]",
    }));
    const { buildLocalAppConfigsPayload } = await import("../src/app-configs.js");
    const result = await buildLocalAppConfigsPayload(context);
    expect(result.payload.files["cursor-user/settings.json"]?.content).toContain('"alt":true');
    expect(result.roots.cursorUser).toBe(altUser);
  });

  it("gist push packages settings from context user dir", async () => {
    const altUser = path.join(tmpRoot, "alt-user", "User");
    const context = makeContext(path.join(tmpRoot, "alt-user"));
    const paths = await import("../src/paths.js");
    const roots = paths.resolveSyncRoots("linux", context);
    const files = await paths.enumerateSyncFiles(context, roots);
    const settings = files.find((f) => f.relativeSyncKey === "cursor-user/settings.json");
    expect(settings?.absolutePath).toBe(path.join(altUser, "settings.json"));
  });

  it("scheduler determineSyncAction reads local checksums from context user dir", async () => {
    const altUser = path.join(tmpRoot, "alt-user", "User");
    const context = makeContext(path.join(tmpRoot, "alt-user"));
    const paths = await import("../src/paths.js");
    const files = await paths.enumerateSyncFiles(context);
    expect(files.some((f) => f.absolutePath === path.join(altUser, "settings.json"))).toBe(true);
  });
});
