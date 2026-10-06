import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runSqliteScript } from "../src/transcripts-sqlite.js";
import { __transcriptsTestUtils } from "../src/transcripts.js";

const { querySqliteRowsImpl } = __transcriptsTestUtils;

const EMOJI_TITLE = "聊天 🧑‍💻 日本語";
const ZWJ_TITLE = "family 👨‍👩‍👧‍👦";

describe("runSqliteScript UTF-8 round-trip", () => {
  it("preserves emoji, ZWJ, and CJK in string literals", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-utf8-sql-"));
    const db = path.join(dir, "t.db");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await exec("python3", [
      "-c",
      [
        "import sqlite3, sys",
        "conn = sqlite3.connect(sys.argv[1])",
        "conn.execute('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')",
        "conn.commit()",
        "conn.close()",
      ].join(";"),
      db,
    ]);

    const payloads = [EMOJI_TITLE, ZWJ_TITLE];
    for (const title of payloads) {
      const escaped = title.replace(/'/g, "''");
      const script =
        `BEGIN IMMEDIATE;\n` +
        `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('title', '${escaped}');\n` +
        `COMMIT;\n`;
      await runSqliteScript(db, script);
    }

    const runQuery = async (dbPath: string, sql: string) => {
      const { SQLITE_PYTHON_FALLBACK_SCRIPT } = await import("../src/transcripts-sqlite.js");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const { stdout } = await exec("python3", ["-c", SQLITE_PYTHON_FALLBACK_SCRIPT, dbPath, sql]);
      return { stdout, stderr: "" };
    };
    const rows = await querySqliteRowsImpl(runQuery, db, "SELECT value FROM ItemTable WHERE key = 'title'", {
      retries: 1,
    });
    expect(rows[0]?.value).toBe(ZWJ_TITLE);
  });
});
