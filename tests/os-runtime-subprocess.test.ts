import { describe, expect, it } from "vitest";
import {
  ALLOWED_SUBPROCESS_COMMANDS,
  assertAllowedSubprocessCommand,
  execFileAsync,
  scrubbedSubprocessEnv,
  spawnSyncCapture,
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

  it("rejects printenv (c04/c05)", async () => {
    expect(() => assertAllowedSubprocessCommand("printenv")).toThrow(
      /not allowlisted/
    );
    expect(() => spawnSyncCapture("printenv", ["HOME"])).toThrow(/not allowlisted/);
    await expect(execFileAsync("printenv", ["HOME"], {})).rejects.toThrow(
      /not allowlisted/
    );
  });

  it("scrubs HOME from subprocess env (c03-c06)", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/secret/home";
    const env = scrubbedSubprocessEnv();
    expect(env.HOME).toBeUndefined();
    if (prev !== undefined) {
      process.env.HOME = prev;
    } else {
      delete process.env.HOME;
    }
  });
});
