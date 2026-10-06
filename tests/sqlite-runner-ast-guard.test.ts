import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSourceText } from "./sync-path-ast-guard.js";
import {
  scanSqliteRunnerViolations,
  scanSqliteRunnerViolationsFromText,
} from "./sqlite-runner-ast-guard.js";

const repoRoot = process.cwd();
const transcriptsSqlite = readFileSync(
  join(repoRoot, "src/transcripts-sqlite.ts"),
  "utf8"
);

describe("sqlite-runner AST guard mutations", () => {
  it("(a) fails when unchecked runner copy is added to transcripts-sqlite.ts", () => {
    const mutated =
      transcriptsSqlite +
      "\nexport async function runSqlitePythonExecutescriptUnchecked(db: string, script: string) {\n" +
      "  await execFileWithStdinAsync('python3', ['-c', SQLITE_PYTHON_EXECUTESCRIPT, db, '20'], script, {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("(b) fails on alias re-export of the script constant", () => {
    const mutated =
      "export { SQLITE_PYTHON_EXECUTESCRIPT } from './transcripts-sqlite.js';\n";
    const offenders = scanSqliteRunnerViolationsFromText("src/evil-reexport.ts", mutated);
    expect(offenders.some((o) => o.includes("re-export"))).toBe(true);
  });

  it("(c) fails when a new src file composes execFileWithStdinAsync + script constant", () => {
    const mutated = `import { execFileWithStdinAsync } from "./os-runtime.js";
import { SQLITE_PYTHON_EXECUTESCRIPT } from "./sqlite-script-safety.js";
export async function evil(db: string, sql: string) {
  await execFileWithStdinAsync("python3", ["-c", SQLITE_PYTHON_EXECUTESCRIPT, db, "20"], sql, {});
}
`;
    const offenders = scanSqliteRunnerViolationsFromText("src/evil-compose.ts", mutated);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("(d) fails when runSqliteScript bypasses assertSafeSqlScript", () => {
    const withoutAssert = transcriptsSqlite.replace(
      "assertSafeSqlScript(sanitized);",
      "// assertSafeSqlScript bypassed"
    );
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      withoutAssert
    );
    expect(
      offenders.some((o) => o.includes("assertSafeSqlScript") || o.includes("runSqliteScript"))
    ).toBe(true);
  });

  it("production src tree stays clean", () => {
    expect(scanSqliteRunnerViolations(repoRoot)).toEqual([]);
  });
});
