import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { mergeComposerHeadersChain } from "../src/composer-merge.js";
import { SQLITE_PYTHON_FALLBACK_SCRIPT } from "../src/transcripts-sqlite.js";
import { __transcriptsTestUtils } from "../src/transcripts.js";

const execFile = promisify(execFileCallback);
const { isCommandMissingError, isExecFileTimeoutError, querySqliteRowsImpl } =
  __transcriptsTestUtils;

describe("isCommandMissingError", () => {
  it("detects SubprocessCommandNotFoundError", async () => {
    const { SubprocessCommandNotFoundError } = await import("../src/subprocess-errors.js");
    expect(isCommandMissingError(new SubprocessCommandNotFoundError("sqlite3"), "sqlite3")).toBe(
      true
    );
  });

  it("detects POSIX spawn ENOENT", () => {
    expect(isCommandMissingError(new Error("spawn sqlite3 ENOENT"), "sqlite3")).toBe(true);
    expect(isCommandMissingError(new Error("spawn python3 ENOENT"), "python3")).toBe(true);
  });

  it("detects Windows-style not recognized messages", () => {
    expect(
      isCommandMissingError(
        new Error("'python3' is not recognized as an internal or external command"),
        "python3"
      )
    ).toBe(true);
    expect(
      isCommandMissingError(new Error("'sqlite3' is not recognized as an internal or external command"), "sqlite3")
    ).toBe(true);
  });

  it("detects exit code 9009 hint", () => {
    expect(isCommandMissingError(new Error("Command failed with exit code 9009"), "sqlite3")).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(isCommandMissingError(new Error("SQLITE_BUSY: database is locked"), "sqlite3")).toBe(false);
    expect(isCommandMissingError(new Error("syntax error near foo"), "sqlite3")).toBe(false);
  });
});

describe("isExecFileTimeoutError", () => {
  it("detects killed and ETIMEDOUT", () => {
    expect(isExecFileTimeoutError(Object.assign(new Error("x"), { killed: true }))).toBe(true);
    expect(isExecFileTimeoutError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isExecFileTimeoutError(new Error("timed out"))).toBe(true);
    expect(isExecFileTimeoutError(new Error("syntax error"))).toBe(false);
  });
});

describe("querySqliteRowsImpl PRAGMA user_version", () => {
  it("parses single JSON line from sqlite3 -json (no bundled PRAGMA busy_timeout)", async () => {
    const stdout = '[{"user_version":2}]\n';
    const runQuery = vi.fn().mockResolvedValue({ stdout, stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/golden.db", "PRAGMA user_version;", {
      retries: 1,
    });
    expect(rows).toEqual([{ user_version: 2 }]);
    expect(runQuery).toHaveBeenCalledWith("/tmp/golden.db", "PRAGMA user_version;");
  });
});

describe("querySqliteRowsImpl", () => {
  it("returns parsed rows on success", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: '[{"key":"k","value":"v"}]', stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([{ key: "k", value: "v" }]);
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when stdout is empty", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: "   \n", stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([]);
  });

  it("propagates non-timeout errors immediately", async () => {
    const err = new Error("spawn python3 ENOENT");
    const runQuery = vi.fn().mockRejectedValue(err);
    await expect(querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 3 })).rejects.toThrow(
      "spawn python3 ENOENT"
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("retries on timeout then succeeds", async () => {
    vi.useFakeTimers();
    const timeoutErr = Object.assign(new Error("Command timed out"), {
      killed: true,
      code: "ETIMEDOUT",
    });
    const runQuery = vi
      .fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue({ stdout: "[]", stderr: "" });

    const rowsPromise = querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 2 });
    await vi.runAllTimersAsync();
    const rows = await rowsPromise;

    expect(rows).toEqual([]);
    expect(runQuery).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("runSqliteQuery python fallback", () => {
  it("returns ItemTable BLOB values as hex when sqlite3 CLI is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-sql-"));
    const dbPath = path.join(tmpDir, "state.vscdb");
    const sql =
      "SELECT key, value FROM ItemTable WHERE key = 'composer.composerHeaders';";
    await execFile("python3", [
      "-c",
      [
        "import json, sqlite3, sys",
        "db = sys.argv[1]",
        "payload = json.dumps({'allComposers': [{'composerId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'name': 'keep'}]})",
        "conn = sqlite3.connect(db)",
        "conn.execute('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')",
        "conn.execute('INSERT INTO ItemTable VALUES (?, ?)', ('composer.composerHeaders', payload.encode()))",
        "conn.commit()",
        "conn.close()",
      ].join(";"),
      dbPath,
    ]);

    const runQuery = async (_dbPath: string, _sql: string) => {
      const { stdout, stderr } = await execFile("python3", [
        "-c",
        SQLITE_PYTHON_FALLBACK_SCRIPT,
        dbPath,
        sql,
      ]);
      return { stdout, stderr };
    };

    const rows = await querySqliteRowsImpl(runQuery, dbPath, sql, { retries: 1 });
    expect(rows).toHaveLength(1);
    const raw = rows[0]?.value;
    expect(typeof raw).toBe("string");
    expect(raw).toMatch(/^[0-9a-f]+$/i);

    const decoded = Buffer.from(String(raw), "hex").toString("utf-8");
    const merged = mergeComposerHeadersChain(decoded, [
      {
        allComposers: [
          {
            composerId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            name: "imported",
            type: "head",
          },
        ],
      },
    ]);
    const ids = merged.allComposers.map((c) => c.composerId);
    expect(ids).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(ids).toContain("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
  });
});
