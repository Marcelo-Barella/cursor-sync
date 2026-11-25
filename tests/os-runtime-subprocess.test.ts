import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_SUBPROCESS_COMMANDS,
  execFileAsync,
  isAllowedSubprocessBasename,
  resolveSubprocessCommand,
  scrubbedSubprocessEnv,
  transportChatSubprocessEnv,
  spawnSyncCapture,
  sqlite3CliArgs,
  subprocessExecFileOptionsForTest,
} from "../src/os-runtime.js";

describe("os-runtime subprocess allowlist", () => {
  it("documents the allowlist", () => {
    expect(ALLOWED_SUBPROCESS_COMMANDS).toEqual([
      "python3",
      "python",
      "py",
      "sqlite3",
      "chmod",
    ]);
  });

  it("accepts python3.12-style basenames", () => {
    expect(isAllowedSubprocessBasename("python3.12")).toBe(true);
    expect(isAllowedSubprocessBasename("python3.11")).toBe(true);
  });

  it("rejects printenv (c04/c05)", async () => {
    expect(() => resolveSubprocessCommand("printenv")).toThrow(/not allowlisted/);
    expect(() => spawnSyncCapture("printenv", ["HOME"])).toThrow(/not allowlisted/);
    await expect(execFileAsync("printenv", ["HOME"], {})).rejects.toThrow(
      /not allowlisted/
    );
  });

  it("rejects relative command paths", () => {
    expect(() => resolveSubprocessCommand("./python3")).toThrow(/relative path/);
    expect(() => resolveSubprocessCommand("subdir/python3")).toThrow(/relative path/);
  });

  it("transportChatSubprocessEnv passes HOME and CURSOR_DOT_DIR for Python parity", () => {
    const prevHome = process.env.HOME;
    const prevDot = process.env.CURSOR_DOT_DIR;
    process.env.HOME = "/tmp/iso-home";
    process.env.CURSOR_DOT_DIR = "/tmp/alt-dot";
    const env = transportChatSubprocessEnv();
    expect(env.HOME).toBe("/tmp/iso-home");
    expect(env.CURSOR_DOT_DIR).toBe("/tmp/alt-dot");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    } else {
      delete process.env.HOME;
    }
    if (prevDot !== undefined) {
      process.env.CURSOR_DOT_DIR = prevDot;
    } else {
      delete process.env.CURSOR_DOT_DIR;
    }
  });

  it("uses allowlisted env only (no secrets)", () => {
    const prev = {
      HOME: process.env.HOME,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.HOME = "/secret/home";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.GITHUB_TOKEN = "gh-token";
    const env = scrubbedSubprocessEnv();
    expect(env.HOME).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
    if (prev.HOME !== undefined) {
      process.env.HOME = prev.HOME;
    } else {
      delete process.env.HOME;
    }
    if (prev.AWS_SECRET_ACCESS_KEY !== undefined) {
      process.env.AWS_SECRET_ACCESS_KEY = prev.AWS_SECRET_ACCESS_KEY;
    } else {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
    if (prev.GITHUB_TOKEN !== undefined) {
      process.env.GITHUB_TOKEN = prev.GITHUB_TOKEN;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("never passes shell or caller env through execFile options", () => {
    const opts = subprocessExecFileOptionsForTest({
      shell: true,
      env: { HOME: "/evil", GITHUB_TOKEN: "x" },
      maxBuffer: 1024,
    });
    expect(opts.shell).toBe(false);
    expect(opts.env?.HOME).toBeUndefined();
    expect(opts.env?.GITHUB_TOKEN).toBeUndefined();
    expect(opts.maxBuffer).toBe(1024);
  });

  it("prefixes sqlite3 args with -safe when supported", () => {
    const args = sqlite3CliArgs(["-json", ":memory:", "select 1"]);
    expect(args[0] === "-safe" || args[0] === "-json").toBe(true);
  });
});
