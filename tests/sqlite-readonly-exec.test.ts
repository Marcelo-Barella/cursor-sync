import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsafeSqlScriptError } from "../src/sqlite-script-safety.js";
import * as osRuntime from "../src/os-runtime.js";
import { runSqliteQuery } from "../src/transcripts-sqlite.js";

describe("runSqliteQuery read-only execution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not create files via writefile (assert blocks before subprocess)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-ro-"));
    const dbPath = path.join(dir, "t.db");
    const evilPath = path.join(dir, "pwn.txt");
    await fs.writeFile(dbPath, "", "utf8");

    await expect(
      runSqliteQuery(dbPath, `SELECT writefile('${evilPath.replace(/'/g, "''")}','x')`)
    ).rejects.toThrow(UnsafeSqlScriptError);
    await expect(
      runSqliteQuery(dbPath, `SELECT "writefile"('${evilPath.replace(/'/g, "''")}','x')`)
    ).rejects.toThrow(UnsafeSqlScriptError);
    await expect(fs.access(evilPath)).rejects.toThrow();
  });

  it("runs legit SELECT via CLI when -safe is supported", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-ro-cli-"));
    const dbPath = path.join(dir, "t.db");
    await fs.writeFile(dbPath, "", "utf8");

    if (!osRuntime.sqlite3CliSupportsSafeFlag()) {
      const { stdout } = await runSqliteQuery(dbPath, "SELECT 1 AS n;");
      expect(stdout).toMatch(/1|"n"/);
      return;
    }

    const execSpy = vi.spyOn(osRuntime, "execFileAsync");
    await runSqliteQuery(dbPath, "SELECT 1 AS n;");
    const sqliteCall = execSpy.mock.calls.find((c) => c[0] === "sqlite3");
    expect(sqliteCall).toBeDefined();
    const args = sqliteCall![1] as string[];
    expect(args).toContain("-readonly");
    expect(args[0]).toBe("-safe");
  });

  it("uses Python fallback when sqlite3 lacks -safe (no CLI read on unsafe shim)", async () => {
    vi.spyOn(osRuntime, "sqlite3CliSupportsSafeFlag").mockReturnValue(false);
    const execSpy = vi.spyOn(osRuntime, "execFileAsync");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-ro-py-"));
    const dbPath = path.join(dir, "t.db");
    await fs.writeFile(dbPath, "", "utf8");

    const evilPath = path.join(dir, "evil.txt");
    await expect(
      runSqliteQuery(dbPath, `SELECT writefile('${evilPath.replace(/'/g, "''")}','x')`)
    ).rejects.toThrow(UnsafeSqlScriptError);

    await runSqliteQuery(dbPath, "SELECT 1 AS n;");
    expect(execSpy.mock.calls.some((c) => c[0] === "sqlite3")).toBe(false);
    await expect(fs.access(evilPath)).rejects.toThrow();
  });

  it("uses Python when sqlite3 is missing (exit-127 style)", async () => {
    const realResolve = osRuntime.resolveSubprocessCommand.bind(osRuntime);
    const { SubprocessCommandNotFoundError } = await import("../src/subprocess-errors.js");
    vi.spyOn(osRuntime, "resolveSubprocessCommand").mockImplementation((command) => {
      if (command === "sqlite3") {
        throw new SubprocessCommandNotFoundError("sqlite3");
      }
      return realResolve(command);
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-ro-miss-"));
    const dbPath = path.join(dir, "t.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { stdout } = await runSqliteQuery(dbPath, "SELECT 1 AS n;");
    expect(stdout).toMatch(/1|"n"/);
  });
});
