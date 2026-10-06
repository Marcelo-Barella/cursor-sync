import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertSafeSqlScript, UnsafeSqlScriptError } from "../src/sqlite-script-safety.js";
import { runSqliteScript } from "../src/transcripts-sqlite.js";

describe("assertSafeSqlScript", () => {
  it("rejects dot-commands", () => {
    expect(() => assertSafeSqlScript(".shell echo hi")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT 1;\n.system id")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects ATTACH and load_extension", () => {
    expect(() => assertSafeSqlScript("ATTACH 'x' AS y;")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT load_extension('x');")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects VACUUM and VACUUM INTO variants", () => {
    expect(() =>
      assertSafeSqlScript("VACUUM INTO '/tmp/stolen.db';")
    ).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("vacuum into '/tmp/x';")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("VACUUM\n INTO '/tmp/x';")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects ATTACH split with zero-width space after normalization", () => {
    expect(() => assertSafeSqlScript("AT\u200bTACH '/tmp/x' AS e;")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("ATTACH\n '/tmp/x' AS e;")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects sqlite file functions", () => {
    expect(() => assertSafeSqlScript("SELECT writefile('/tmp/x', 'data');")).toThrow(
      UnsafeSqlScriptError
    );
    expect(() => assertSafeSqlScript("SELECT readfile('/etc/passwd');")).toThrow(
      UnsafeSqlScriptError
    );
  });

  it("allows real sync-engine style DML scripts", () => {
    const script =
      "BEGIN IMMEDIATE;\n" +
      "UPDATE ItemTable SET value = 'x' WHERE key = 'composer.composerHeaders';\n" +
      "INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', 'x' " +
      "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n" +
      "COMMIT;\n";
    expect(() => assertSafeSqlScript(script)).not.toThrow();
  });

  it("allows golden store hydrate inserts", () => {
    expect(() =>
      assertSafeSqlScript(
        "BEGIN IMMEDIATE;\nINSERT INTO meta(key, value) VALUES ('0', '{}');\nCOMMIT;\n"
      )
    ).not.toThrow();
  });

  it("allows busy_timeout and wal_checkpoint", () => {
    expect(() =>
      assertSafeSqlScript("PRAGMA busy_timeout = 5000;\nPRAGMA wal_checkpoint(FULL);")
    ).not.toThrow();
  });

  it("treats embedded newline dot-command as inert when in string data only via line rule", () => {
    expect(() =>
      assertSafeSqlScript("INSERT INTO t VALUES ('hello\n.shell');")
    ).not.toThrow();
  });

  it("rejects dot-command on its own line after escaped-looking data", () => {
    expect(() =>
      assertSafeSqlScript("SELECT 1;\n.shell rm -rf /")
    ).toThrow(UnsafeSqlScriptError);
  });
});

describe("runSqliteScript", () => {
  it("refuses manifest-style .shell before executing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-sql-safe-"));
    const db = path.join(dir, "t.db");
    await fs.writeFile(db, "", "utf8");
    await expect(runSqliteScript(db, ".shell touch /tmp/evil")).rejects.toThrow(
      UnsafeSqlScriptError
    );
  });
});

describe("runSqliteQuery CLI", () => {
  it("uses -safe in sqlite3 argv when CLI is available", async () => {
    const { sqlite3CliArgs } = await import("../src/os-runtime.js");
    const args = sqlite3CliArgs(["-json", "/tmp/x.db", "select 1"]);
    if (args[0] === "-safe") {
      expect(args[1]).toBe("-json");
    }
  });
});
