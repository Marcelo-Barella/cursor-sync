import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as osRuntime from "../src/os-runtime.js";
import { SubprocessCommandNotFoundError } from "../src/subprocess-errors.js";
import { isCommandMissingError, runSqliteQuery } from "../src/transcripts-sqlite.js";

describe("sqlite3 missing on PATH", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isCommandMissingError matches SubprocessCommandNotFoundError", () => {
    expect(
      isCommandMissingError(new SubprocessCommandNotFoundError("sqlite3"), "sqlite3")
    ).toBe(true);
  });

  it("falls back to Python for runSqliteQuery", async () => {
    const realResolve = osRuntime.resolveSubprocessCommand.bind(osRuntime);
    vi.spyOn(osRuntime, "resolveSubprocessCommand").mockImplementation((command) => {
      if (command === "sqlite3") {
        throw new SubprocessCommandNotFoundError("sqlite3");
      }
      return realResolve(command);
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-pysql-"));
    const dbPath = path.join(dir, "t.db");
    await fs.writeFile(dbPath, "", "utf8");
    const { stdout } = await runSqliteQuery(dbPath, "SELECT 1 AS n;");
    expect(stdout).toMatch(/1|"n"/);
  });
});
