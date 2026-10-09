import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLITE_PYTHON_EXECUTESCRIPT } from "./fixtures/sqlite-python-executescript-constant.js";
import {
  extractSqlitePythonExecutescriptFromTranscriptsSource,
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

  it("(a2) fails when a nested runSqliteScript runs unchecked stdin", () => {
    const mutated =
      transcriptsSqlite +
      "\nfunction outer() {\n" +
      "  async function runSqliteScript(db: string, script: string) {\n" +
      "    await execFileWithStdinAsync('python3', ['-c', SQLITE_PYTHON_EXECUTESCRIPT, db, '20'], script, {});\n" +
      "  }\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("runSqliteScript"))).toBe(true);
  });

  it("(b) fails on alias re-export of the script constant", () => {
    const mutated =
      "export { SQLITE_PYTHON_EXECUTESCRIPT } from './transcripts-sqlite.js';\n";
    const offenders = scanSqliteRunnerViolationsFromText("src/evil-reexport.ts", mutated);
    expect(offenders.some((o) => o.includes("re-export"))).toBe(true);
  });

  it("(b2) fails when execFileWithStdinAsync is env-gated outside safe runners", () => {
    const mutated =
      transcriptsSqlite +
      "\nasync function envGated(db: string, script: string) {\n" +
      "  if (process.env.ALLOW) {\n" +
      "    await execFileWithStdinAsync('sqlite3', ['-bail', db], script, {});\n" +
      "  }\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes(EXEC_STDIN))).toBe(true);
  });

  it("(b3) fails when execFileWithStdinAsync is try-swallowed outside safe runners", () => {
    const mutated =
      transcriptsSqlite +
      "\nasync function swallowed(db: string, script: string) {\n" +
      "  try {\n" +
      "    await execFileWithStdinAsync('sqlite3', ['-bail', db], script, {});\n" +
      "  } catch {}\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes(EXEC_STDIN))).toBe(true);
  });

  it("(b4) fails when aliased execFileWithStdinAsync runs outside safe runners", () => {
    const mutated = `import { execFileWithStdinAsync as runStdin } from "./os-runtime.js";
import { SQLITE_PYTHON_EXECUTESCRIPT } from "./sqlite-script-safety.js";
export async function evil(db: string, sql: string) {
  await runStdin("python3", ["-c", SQLITE_PYTHON_EXECUTESCRIPT, db, "20"], sql, {});
}
`;
    const offenders = scanSqliteRunnerViolationsFromText("src/evil-compose.ts", mutated);
    expect(offenders.length).toBeGreaterThan(0);
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

  it("(c2) fails when os.execFileWithStdinAsync uses inline Python -c", () => {
    const mutated =
      transcriptsSqlite +
      "\nimport * as os from './os-runtime.js';\n" +
      "async function inlinePy(db: string, script: string) {\n" +
      "  await os.execFileWithStdinAsync('python3', ['-c', 'import sqlite3', db], script, {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes(EXEC_STDIN))).toBe(true);
  });

  it("(c3) fails when an exported helper autocommits without assertSafeSqlScript", () => {
    const mutated =
      transcriptsSqlite +
      "\nexport async function runSqliteCliWrites(db: string, script: string) {\n" +
      "  await execFileWithStdinAsync('sqlite3', ['-bail', db], script, {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("runSqliteCliWrites"))).toBe(true);
  });

  it("(a-env) fails when assertSafeSqlScript is env-gated inside runSqliteScript", () => {
    const mutated = transcriptsSqlite.replace(
      "assertSafeSqlScript(sanitized);",
      "if (!process.env.SKIP) { assertSafeSqlScript(sanitized); }"
    );
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("unconditional"))).toBe(true);
  });

  it("(b-swallow) fails when assertSafeSqlScript is try-swallowed in runSqliteScript", () => {
    const mutated = transcriptsSqlite.replace(
      "assertSafeSqlScript(sanitized);",
      "try { assertSafeSqlScript(sanitized); } catch {}"
    );
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("unconditional"))).toBe(true);
  });

  it("(c-destructure) fails when object-destructured exec alias runs outside safe runners", () => {
    const mutated =
      transcriptsSqlite +
      "\nasync function evilDestructure() {\n" +
      "  const { execFileWithStdinAsync: runStdin } = await import('./os-runtime.js');\n" +
      "  await runStdin('sqlite3', ['-bail', 'x.db'], 'SELECT 1', {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("(c-let) fails when let-reassigned execFileWithStdinAsync alias runs outside safe runners", () => {
    const mutated =
      transcriptsSqlite +
      "\nasync function evilLet() {\n" +
      "  let runStdin = execFileWithStdinAsync;\n" +
      "  runStdin = execFileWithStdinAsync;\n" +
      "  await runStdin('sqlite3', ['-bail', 'x.db'], 'SELECT 1', {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("(c-alias) fails when a local execFileWithStdinAsync alias runs outside safe runners", () => {
    const mutated =
      transcriptsSqlite +
      "\nconst runStdin = execFileWithStdinAsync;\n" +
      "async function evilAlias(db: string, script: string) {\n" +
      "  await runStdin('sqlite3', ['-bail', db], script, {});\n" +
      "}\n";
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("(d-readonly-cli) fails when runSqliteQuery drops -readonly from sqlite3 argv", () => {
    const mutated = transcriptsSqlite.replace('"-readonly", ', "");
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("-readonly"))).toBe(true);
  });

  it("(d-safe-gate) fails when runSqliteQuery drops sqlite3CliSupportsSafeFlag gate", () => {
    const mutated = transcriptsSqlite.replace(/const cliSafeForRead = sqlite3CliSupportsSafeFlag\(\);\n/, "");
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("sqlite3CliSupportsSafeFlag"))).toBe(true);
  });

  it("(d-readonly) fails when runSqliteQuery drops assertReadOnlySqliteQuery", () => {
    const mutated = transcriptsSqlite.replace(
      "assertReadOnlySqliteQuery(sql);",
      "// read-only assert removed"
    );
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      mutated
    );
    expect(offenders.some((o) => o.includes("runSqliteQuery"))).toBe(true);
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

  it("(i) fails when runSqliteCliSafeStdin bypasses assertSafeSqlScript", () => {
    const withoutAssert = transcriptsSqlite.replace(
      /export async function runSqliteCliSafeStdin[\s\S]*?assertSafeSqlScript\(script\);/,
      `export async function runSqliteCliSafeStdin(
  dbPath: string,
  script: string
): Promise<void> {
  // assert removed`
    );
    const offenders = scanSqliteRunnerViolationsFromText(
      "src/transcripts-sqlite.ts",
      withoutAssert
    );
    expect(offenders.some((o) => o.includes("runSqliteCliSafeStdin"))).toBe(true);
  });

  it("(g+a) test fixture matches production SQLITE_PYTHON_EXECUTESCRIPT bytes", () => {
    const production = extractSqlitePythonExecutescriptFromTranscriptsSource(transcriptsSqlite);
    expect(production).toBeDefined();
    expect(production).toBe(SQLITE_PYTHON_EXECUTESCRIPT);
  });

  it("production src tree stays clean", () => {
    expect(scanSqliteRunnerViolations(repoRoot)).toEqual([]);
  });
});

const SAFE_ASSERT = "assertSafeSqlScript";
const EXEC_STDIN = "execFileWithStdinAsync";
