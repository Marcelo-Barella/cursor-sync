import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileWithStdinAsync } from "../src/os-runtime.js";
import {
  assertSafeSqlScript,
  buildStatementSecuritySurfaces,
  tokenizeSqlScript,
  UnsafeSqlScriptError,
} from "../src/sqlite-script-safety.js";

/** Common Cf codepoints SQLite treats as identifier chars (must reject outside '...'). */
const CF_CODEPOINTS = [
  0x00ad, // soft hyphen
  0x180e, // mongolian vowel separator (deprecated Cf)
  0x200b, // ZWSP
  0x200c, // ZWNJ
  0x200d, // ZWJ (allowed inside string literals only)
  0x200e, // LRM
  0x200f, // RLM
  0x2060, // word joiner
  0xfeff, // BOM
];

function cf(ch: number): string {
  return String.fromCodePoint(ch);
}

const RAW_SQLITE_RUNNER = [
  "import os, sqlite3, sys",
  "db_path, watch_dir = sys.argv[1], sys.argv[2]",
  "sql = sys.stdin.read()",
  "def split_sqlite(script):",
  "    parts = []",
  "    i = 0",
  "    n = len(script)",
  "    while i < n:",
  "        while i < n and script[i] in ' \\t\\n\\f\\r':",
  "            i += 1",
  "        if i >= n:",
  "            break",
  "        j = i + 1",
  "        while j <= n:",
  "            if sqlite3.complete_statement(script[i:j]):",
  "                stmt = script[i:j].strip()",
  "                if stmt:",
  "                    parts.append(stmt)",
  "                i = j",
  "                break",
  "            j += 1",
  "        else:",
  "            break",
  "    return parts",
  "oracle_count = len(split_sqlite(sql))",
  "conn = sqlite3.connect(db_path)",
  "try:",
  "    try:",
  "        conn.executescript(sql)",
  "        conn.commit()",
  "    except sqlite3.Error:",
  "        pass",
  "finally:",
  "    conn.close()",
  "extras = [f for f in os.listdir(watch_dir) if f.endswith('.db') and f != os.path.basename(db_path)]",
  "print(oracle_count)",
  "print(len(extras))",
].join("\n");

async function runRawSqliteOracle(
  dbPath: string,
  watchDir: string,
  script: string
): Promise<{ oracleStatementCount: number; extraDbCount: number }> {
  const { stdout } = await execFileWithStdinAsync(
    "python3",
    ["-c", RAW_SQLITE_RUNNER, dbPath, watchDir],
    script,
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }
  );
  const lines = stdout.trim().split("\n");
  return {
    oracleStatementCount: Number(lines[0]),
    extraDbCount: Number(lines[1]),
  };
}

describe("Cf / non-ASCII outside string literals", () => {
  it("rejects tester Cf block-comment VACUUM INTO bypass", () => {
    const wj = "\u2060";
    const sql =
      `SELECT 4 /${wj}* 2 FROM (SELECT 2 AS [${wj}]);VACUUM INTO 'o4.db'`;
    expect(() => assertSafeSqlScript(sql)).toThrow(UnsafeSqlScriptError);
  });

  it("rejects Cf in each fake comment opener position", () => {
    for (const cp of CF_CODEPOINTS) {
      const c = cf(cp);
      expect(() => assertSafeSqlScript(`SELECT 1; -${c}- ATTACH 'x' AS y;`)).toThrow(
        UnsafeSqlScriptError
      );
      expect(() => assertSafeSqlScript(`SELECT 1; /${c}* ATTACH 'x' AS y;`)).toThrow(
        UnsafeSqlScriptError
      );
      expect(() => assertSafeSqlScript(`SELECT 1; *${c}/ ATTACH 'x' AS y;`)).toThrow(
        UnsafeSqlScriptError
      );
    }
  });

  it("rejects Cf inside identifiers and split keywords", () => {
    for (const cp of CF_CODEPOINTS) {
      const c = cf(cp);
      if (cp === 0x200d) {
        continue;
      }
      expect(() => assertSafeSqlScript(`VAC${c}UUM INTO 'x.db';`)).toThrow(UnsafeSqlScriptError);
      expect(() => assertSafeSqlScript(`SELECT 1 FROM t${c}bl;`)).toThrow(UnsafeSqlScriptError);
    }
    expect(() => assertSafeSqlScript("VAC\u200bUUM INTO 'x.db';")).toThrow(UnsafeSqlScriptError);
  });

  it("rejects non-ASCII in double/backtick/bracket quoted identifiers", () => {
    expect(() => assertSafeSqlScript('SELECT 1 AS "caf\u00e9";')).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT 1 AS [`\u200b`];")).toThrow(UnsafeSqlScriptError);
    expect(() => assertSafeSqlScript("SELECT 1 AS [\u2060];")).toThrow(UnsafeSqlScriptError);
  });

  it("allows emoji, ZWJ, RTL marks, and BOM inside single-quoted chat literals", () => {
    const emoji = "👋 family \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67";
    const rtl = "\u200Ehello\u200F";
    const bom = "\uFEFFtitle";
    const escaped = (s: string) => s.replace(/'/g, "''");
    const script =
      "BEGIN IMMEDIATE;\n" +
      `INSERT INTO ItemTable(key,value) VALUES ('k', '${escaped(emoji)}');\n` +
      `INSERT INTO ItemTable(key,value) VALUES ('k2', '${escaped(rtl)}');\n` +
      `INSERT INTO ItemTable(key,value) VALUES ('k3', '${escaped(bom)}');\n` +
      "COMMIT;\n";
    expect(() => assertSafeSqlScript(script)).not.toThrow();
    const surfaces = buildStatementSecuritySurfaces(script, tokenizeSqlScript(script));
    expect(surfaces.join(" ")).toContain("INSERT");
    expect(script).toContain("\u200D");
    expect(script).toContain("\u200E");
    expect(script).toContain("\uFEFF");
  });
});

describe("cf differential property", () => {
  const keywords = ["ATTACH", "VACUUM", "SELECT", "INSERT", "DELETE", "load_extension"];
  const commentOpeners = ["--", "/*", "*/"];
  const quotes = ["'", '"', "`", "[", "]"];
  const cfChars = CF_CODEPOINTS.map(cf);

  function randomChoice<T>(arr: T[], rng: () => number): T {
    return arr[Math.floor(rng() * arr.length)]!;
  }

  function maybeInjectCf(text: string, rng: () => number): string {
    if (rng() > 0.4) {
      return text;
    }
    const c = randomChoice(cfChars, rng);
    const pos = Math.floor(rng() * (text.length + 1));
    return text.slice(0, pos) + c + text.slice(pos);
  }

  it("filter-accepts implies raw sqlite creates no extra db and statement count matches oracle", async () => {
    const fuzzCount = Number(process.env.SQL_CF_FUZZ_COUNT ?? "2000");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-cf-fuzz-"));
    const db = path.join(dir, "main.db");
    await fs.writeFile(db, "", "utf8");

    let seed = 0x31_cf;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let trial = 0; trial < fuzzCount; trial++) {
      let sql = "";
      const parts = 2 + Math.floor(rng() * 8);
      for (let p = 0; p < parts; p++) {
        sql += maybeInjectCf(randomChoice(commentOpeners, rng), rng);
        sql += maybeInjectCf(randomChoice(quotes, rng), rng);
        if (rng() > 0.45) {
          sql += maybeInjectCf(randomChoice(keywords, rng), rng);
        }
        if (rng() > 0.7) {
          const lit = maybeInjectCf("chat\u200Dtext", rng);
          sql += `'${lit.replace(/'/g, "''")}'`;
        }
        sql += "\n";
      }
      if (rng() > 0.25) {
        sql += maybeInjectCf("SELECT 1;", rng);
      }

      let accepted = false;
      try {
        assertSafeSqlScript(sql);
        accepted = true;
      } catch {
        continue;
      }

      const filterCount = buildStatementSecuritySurfaces(sql, tokenizeSqlScript(sql)).length;
      const { oracleStatementCount, extraDbCount } = await runRawSqliteOracle(db, dir, sql);
      expect(extraDbCount).toBe(0);
      expect(filterCount).toBe(oracleStatementCount);
    }
  }, 120_000);
});
