import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => testEnv.home,
  };
});

const testEnv = { home: "" };

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

describe("executeInstallSkillTransportChat", () => {
  let tmpRoot: string;
  let bundledRoot: string;
  let savedPlatform: NodeJS.Platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "install-skill-"));
    testEnv.home = tmpRoot;
    process.env.HOME = tmpRoot;
    bundledRoot = path.join(tmpRoot, "extension", "resources", "transport-chat");
    await fs.mkdir(path.join(bundledRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(bundledRoot, "VERSION"), "1.0.0\n");
    await fs.writeFile(path.join(bundledRoot, "SKILL.md"), "# skill\n");
    await fs.writeFile(path.join(bundledRoot, "scripts", "run.sh"), "#!/bin/sh\n");
    savedPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const vscode = await import("vscode");
    vi.spyOn(vscode.window, "showErrorMessage").mockImplementation(showErrorMessageMock);
    vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(
      showInformationMessageMock
    );
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: savedPlatform,
      configurable: true,
    });
  });

  function context(): import("vscode").ExtensionContext {
    return {
      extensionUri: { fsPath: path.join(tmpRoot, "extension") },
    } as unknown as import("vscode").ExtensionContext;
  }

  it("(a) fresh install copies files and shows Installed message", async () => {
    const { executeInstallSkillTransportChat } = await import(
      "../src/install-skill-transport-chat.js"
    );
    const target = path.join(tmpRoot, ".cursor", "skills", "transport-chat");
    await executeInstallSkillTransportChat(context());
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/^Cursor Sync: Installed transport-chat skill v1\.0\.0 at /)
    );
    expect(await fs.readFile(path.join(target, "VERSION"), "utf8")).toBe("1.0.0\n");
    const rel = (root: string, files: string[]) =>
      files.map((f) => path.relative(root, f)).sort();
    expect(rel(target, await listFilesRecursive(target))).toEqual(
      rel(bundledRoot, await listFilesRecursive(bundledRoot))
    );
  });

  it("(b) same version reinstall shows Reinstalled message", async () => {
    const target = path.join(tmpRoot, ".cursor", "skills", "transport-chat");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "VERSION"), "1.0.0\n");
    await fs.writeFile(path.join(target, "SKILL.md"), "stale\n");
    const { executeInstallSkillTransportChat } = await import(
      "../src/install-skill-transport-chat.js"
    );
    await executeInstallSkillTransportChat(context());
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      "Cursor Sync: Reinstalled transport-chat skill v1.0.0 (no version change)."
    );
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# skill\n");
  });

  it("(c) version update shows Updated message", async () => {
    const target = path.join(tmpRoot, ".cursor", "skills", "transport-chat");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "VERSION"), "0.9.0\n");
    const { executeInstallSkillTransportChat } = await import(
      "../src/install-skill-transport-chat.js"
    );
    await executeInstallSkillTransportChat(context());
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      "Cursor Sync: Updated transport-chat skill 0.9.0 -> 1.0.0."
    );
  });

  it("(d) non-Linux returns early with error", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.resetModules();
    const vscode = await import("vscode");
    vi.spyOn(vscode.window, "showErrorMessage").mockImplementation(showErrorMessageMock);
    vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(
      showInformationMessageMock
    );
    const { executeInstallSkillTransportChat } = await import(
      "../src/install-skill-transport-chat.js"
    );
    const target = path.join(tmpRoot, ".cursor", "skills", "transport-chat");
    await executeInstallSkillTransportChat(context());
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Cursor Sync: The transport-chat skill is currently supported on Linux only."
    );
    await expect(fs.access(target)).rejects.toThrow();
    expect(showInformationMessageMock).not.toHaveBeenCalled();
  });

  it("(e) missing bundled VERSION shows error", async () => {
    await fs.unlink(path.join(bundledRoot, "VERSION"));
    const { executeInstallSkillTransportChat } = await import(
      "../src/install-skill-transport-chat.js"
    );
    await executeInstallSkillTransportChat(context());
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Bundled transport-chat skill is missing a VERSION file; reinstall the extension."
    );
  });
});
