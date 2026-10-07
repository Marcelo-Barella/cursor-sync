import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transportChatSubprocessEnv } from "../src/os-runtime.js";

const spawnCaptureMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: () => ({}),
    }),
  },
}));

vi.mock("../src/os-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/os-runtime.js")>();
  return {
    ...actual,
    spawnPython3Capture: (...args: unknown[]) => spawnCaptureMock(...args),
  };
});

describe("transport-chat path isolation", () => {
  const scriptsDir = path.join(
    process.cwd(),
    "resources",
    "transport-chat",
    "scripts"
  );

  afterEach(() => {
    spawnCaptureMock.mockReset();
    vi.clearAllMocks();
  });

  it("runPythonDiskImport passes transportChatSubprocessEnv with HOME to spawn", async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/tmp/iso-home-spawn-test";
    spawnCaptureMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const { runPythonDiskImport } = await import("../src/chat-transport-scripts.js");
    await runPythonDiskImport({
      bundlePath: "/tmp/fake-bundle.json",
      workspaceFolder: os.tmpdir(),
      extensionPath: process.cwd(),
    });

    expect(spawnCaptureMock).toHaveBeenCalled();
    const call = spawnCaptureMock.mock.calls[0]?.[0] as { env?: NodeJS.ProcessEnv };
    expect(call.env?.HOME).toBe("/tmp/iso-home-spawn-test");

    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("python chats_root resolves under isolated HOME", async () => {
    const isoHome = await fs.mkdtemp(path.join(os.tmpdir(), "iso-home-"));
    const env = transportChatSubprocessEnv();
    env.HOME = isoHome;
    delete env.CURSOR_DOT_DIR;

    const py = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from cursor_chat_io_common import chats_root",
      "print(chats_root())",
    ].join(";");

    const res = spawnSync("python3", ["-c", py], {
      env,
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
    const chats = res.stdout.trim();
    expect(chats).toBe(path.join(isoHome, ".cursor", "chats"));
    expect(chats).not.toContain(os.homedir());
  });

  it("python chats_root honors CURSOR_DOT_DIR over HOME/.cursor", async () => {
    const isoHome = await fs.mkdtemp(path.join(os.tmpdir(), "iso-home-"));
    const altDot = await fs.mkdtemp(path.join(os.tmpdir(), "alt-dot-"));
    const env = transportChatSubprocessEnv();
    env.HOME = isoHome;
    env.CURSOR_DOT_DIR = altDot;

    const py = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from cursor_chat_io_common import chats_root",
      "print(chats_root())",
    ].join(";");

    const res = spawnSync("python3", ["-c", py], {
      env,
      encoding: "utf-8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(path.join(altDot, "chats"));
  });
});
