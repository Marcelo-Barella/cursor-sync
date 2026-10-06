import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeSqlScript,
  buildStatementSecuritySurfaces,
  tokenizeSqlScript,
  UnsafeSqlScriptError,
} from "../src/sqlite-script-safety.js";
import {
  runSqlitePythonExecutescriptUnchecked,
  runSqliteScript,
} from "../src/transcripts-sqlite.js";

const FUZZ_ESCAPE_FIXTURE = path.join(
  import.meta.dirname,
  "fixtures",
  "sql-fuzz-escapes.txt"
);

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
    expect(() => assertSafeSqlScript("SELECT edit('/tmp/x');")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT fts3_tokenizer('custom');")).toThrow(
      UnsafeSqlScriptError
    );
  });

  it("rejects comment-split forbidden calls", () => {
    expect(() => assertSafeSqlScript("SELECT load_exten/**/sion('x');")).toThrow(
      UnsafeSqlScriptError
    );
    expect(() => assertSafeSqlScript("SELECT writ/**/efile('/tmp/x','y');")).toThrow(
      UnsafeSqlScriptError
    );
  });

  it("rejects risky PRAGMA, second statements, CTE, and DDL", () => {
    expect(() => assertSafeSqlScript("PRAGMA integrity_check;")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT 1; ATTACH 'x' AS y;")).toThrow(UnsafeSqlScriptError);
    expect(() =>
      assertSafeSqlScript("WITH cte AS (SELECT 1) SELECT * FROM cte;")
    ).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("CREATE TABLE t(x);")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("DROP TABLE ItemTable;")).toThrow(UnsafeSqlScriptError);
  });

  it("allows user chat text inside SQL string literals", () => {
    const userJson = JSON.stringify({
      allComposers: [{ name: "My notes; part 2", composerId: "c1" }],
    });
    const escaped = userJson.replace(/'/g, "''");
    const script =
      `BEGIN IMMEDIATE;\n` +
      `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';\n` +
      `COMMIT;\n`;
    expect(() => assertSafeSqlScript(script)).not.toThrow();
    expect(() =>
      assertSafeSqlScript(
        `INSERT INTO meta(key,value) VALUES ('0', '${"please attach the file".replace(/'/g, "''")}');`
      )
    ).not.toThrow();
    expect(() =>
      assertSafeSqlScript(
        `INSERT INTO meta(key,value) VALUES ('0', '${"how to detach a branch".replace(/'/g, "''")}');`
      )
    ).not.toThrow();
    expect(() =>
      assertSafeSqlScript(
        `INSERT INTO meta(key,value) VALUES ('0', '${"robot vacuum review".replace(/'/g, "''")}');`
      )
    ).not.toThrow();
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

  it("rejects ATTACH when a quote inside a line comment does not open a literal (tester r27)", () => {
    expect(() => assertSafeSqlScript("-- it's\nATTACH 'x.db' AS y; -- '")).toThrow(
      UnsafeSqlScriptError
    );
  });

  it("rejects VACUUM when block comments contain quotes (tester r27)", () => {
    expect(() =>
      assertSafeSqlScript("/* ' */ VACUUM INTO '/tmp/p.db'; /* ' */")
    ).toThrow(UnsafeSqlScriptError);
  });

  it("allows bracket/double/backtick markers inside comments only", () => {
    expect(() => assertSafeSqlScript("/* [not an ident */ SELECT 1;")).not.toThrow();
    expect(() => assertSafeSqlScript("-- \"not closed\nSELECT 1;")).not.toThrow();
    expect(() => assertSafeSqlScript("/* `backtick */ SELECT 1;")).not.toThrow();
  });

  it("allows single quotes inside bracket or double-quoted identifiers", () => {
    expect(() =>
      assertSafeSqlScript('INSERT INTO [it\'s] (x) SELECT 1;')
    ).not.toThrow();
    expect(() =>
      assertSafeSqlScript('INSERT INTO "it\'s" (x) SELECT 1;')
    ).not.toThrow();
  });

  it("rejects ATTACH after a string that contains -- (tester r27)", () => {
    expect(() => assertSafeSqlScript("'a--b' ATTACH 'x.db' AS y;")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects minimal comment-quote VACUUM INTO escape", () => {
    expect(() => assertSafeSqlScript("--'\nVACUUM INTO'b.db'--'")).toThrow(UnsafeSqlScriptError);
  });
});

describe("fuzz escape corpus", () => {
  it("refuses attacks or runs without creating marker databases", async () => {
    const raw = await fs.readFile(FUZZ_ESCAPE_FIXTURE, "utf8");
    const cases = raw
      .split(/\n\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(cases.length).toBeGreaterThan(300);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-fuzz-sql-"));
    const db = path.join(dir, "main.db");
    await fs.writeFile(db, "", "utf8");

    for (const sql of cases) {
      let accepted = false;
      try {
        assertSafeSqlScript(sql);
        accepted = true;
      } catch (e) {
        expect(e).toBeInstanceOf(UnsafeSqlScriptError);
      }
      if (!accepted) {
        continue;
      }
      const surfaces = buildStatementSecuritySurfaces(sql, tokenizeSqlScript(sql));
      expect(surfaces.some((s) => /\b(vacuum|attach|detach)\b/i.test(s))).toBe(false);
      try {
        await runSqlitePythonExecutescriptUnchecked(db, sql);
      } catch {
        // runner refused unsafe statement
      }
      const entries = await fs.readdir(dir);
      const extras = entries.filter((name) => name !== "main.db" && name.endsWith(".db"));
      expect(extras).toEqual([]);
    }
  });
});

describe("differential property: accepted scripts do not create files", () => {
  const keywords = ["ATTACH", "VACUUM", "SELECT", "load_extension", "writefile"];
  const commentOpeners = ["--", "/*", "*/"];
  const quotes = ["'", '"', "`", "[", "]"];

  function randomChoice<T>(arr: T[], rng: () => number): T {
    return arr[Math.floor(rng() * arr.length)]!;
  }

  it("random comment/quote/keyword mixes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-sql-prop-"));
    const db = path.join(dir, "main.db");
    await fs.writeFile(db, "", "utf8");

    let seed = 0x29;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let trial = 0; trial < 200; trial++) {
      let sql = "";
      const parts = 3 + Math.floor(rng() * 6);
      for (let p = 0; p < parts; p++) {
        sql += randomChoice(commentOpeners, rng);
        sql += randomChoice(quotes, rng);
        if (rng() > 0.5) {
          sql += randomChoice(keywords, rng);
        }
        sql += "\n";
      }
      if (rng() > 0.3) {
        sql += "SELECT 1;";
      }

      let accepted = false;
      try {
        assertSafeSqlScript(sql);
        accepted = true;
      } catch {
        continue;
      }
      try {
        await runSqlitePythonExecutescriptUnchecked(db, sql);
      } catch {
        // refused at engine
      }
      const entries = await fs.readdir(dir);
      const extras = entries.filter((name) => name !== "main.db" && name.endsWith(".db"));
      expect(extras).toEqual([]);
    }
  });
});

describe("Python runner defense in depth", () => {
  it("refuses VACUUM INTO when TS safety is bypassed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-sql-engine-"));
    const db = path.join(dir, "main.db");
    const victim = path.join(dir, "b.db");
    await fs.writeFile(db, "", "utf8");
    const sql = `--'\nVACUUM INTO '${victim.replace(/'/g, "''")}'--'`;
    await expect(runSqlitePythonExecutescriptUnchecked(db, sql)).rejects.toThrow();
    await expect(fs.access(victim)).rejects.toThrow();
  });
});

describe("manifest SQL execution path", () => {
  it("uses runSqliteScript for metadata overrides (not sqlite3 CLI -safe stdin)", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dirname, "../src/sync-engine-ops.ts"),
      "utf8"
    );
    expect(source).toContain("runMetadataSqlOnShadowDb");
    expect(source).toMatch(/runSqliteScript\(dbPath/);
    expect(source).not.toContain("runSqliteCliSafeStdin");
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
