const ALLOWED_PRAGMA_NAMES = new Set([
  "busy_timeout",
  "wal_checkpoint",
  "user_version",
  "encoding",
  "foreign_keys",
  "journal_mode",
  "synchronous",
  "temp_store",
]);

const ALLOWED_STATEMENT_KEYWORDS = new Set([
  "begin",
  "commit",
  "rollback",
  "insert",
  "update",
  "delete",
  "replace",
  "select",
  "pragma",
]);

const FORBIDDEN_NORMALIZED_PATTERNS: RegExp[] = [
  /\battach\b/i,
  /\bdetach\b/i,
  /\bvacuum\b/i,
  /\bload_extension\s*\(/i,
  /\bwritefile\s*\(/i,
  /\breadfile\s*\(/i,
  /\bedit\s*\(/i,
  /\bfts3_tokenizer\s*\(/i,
];

export class UnsafeSqlScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSqlScriptError";
  }
}

function stripUnicodeFormatChars(text: string): string {
  return text.replace(/\p{Cf}/gu, "");
}

/** Remove SQL comments and collapse whitespace for security matching. */
export function normalizeSqlForSafetyAnalysis(script: string): string {
  let s = stripUnicodeFormatChars(script);
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/--[^\n\r]*/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function lineLooksLikeDotCommand(line: string): boolean {
  const t = line.trimStart();
  return t.length > 0 && t.startsWith(".");
}

function forEachSqlLineOutsideStrings(
  script: string,
  onLine: (line: string, lineNumber: number) => void
): void {
  let inSingle = false;
  let line = "";
  let lineNumber = 1;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "'" && !inSingle) {
      inSingle = true;
      line += ch;
      continue;
    }
    if (ch === "'" && inSingle) {
      if (script[i + 1] === "'") {
        line += "''";
        i++;
        continue;
      }
      inSingle = false;
      line += ch;
      continue;
    }
    if (!inSingle && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && script[i + 1] === "\n") {
        i++;
      }
      onLine(line, lineNumber);
      line = "";
      lineNumber++;
      continue;
    }
    line += ch;
  }
  if (line.length > 0) {
    onLine(line, lineNumber);
  }
}

function splitSqlStatements(normalized: string): string[] {
  if (!normalized) {
    return [];
  }
  return normalized
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function leadingStatementKeyword(statement: string): string | undefined {
  const m = statement.match(/^([a-z_]+)/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

function assertStatementAllowed(statement: string): void {
  const keyword = leadingStatementKeyword(statement);
  if (!keyword) {
    throw new UnsafeSqlScriptError("SQL script contains an empty or unrecognized statement");
  }
  if (!ALLOWED_STATEMENT_KEYWORDS.has(keyword)) {
    throw new UnsafeSqlScriptError(
      `SQL statement kind "${keyword}" is not allowed in manifest or sync scripts`
    );
  }
  if (keyword === "pragma") {
    const pragmaMatch = statement.match(/\bpragma\s+([a-z_]+)/i);
    const name = pragmaMatch?.[1]?.toLowerCase();
    if (!name || !ALLOWED_PRAGMA_NAMES.has(name)) {
      throw new UnsafeSqlScriptError(`PRAGMA ${name ?? "(unknown)"} is not allowlisted`);
    }
  }
}

function assertNormalizedForbiddenTokens(normalized: string): void {
  for (const re of FORBIDDEN_NORMALIZED_PATTERNS) {
    if (re.test(normalized)) {
      throw new UnsafeSqlScriptError(
        "SQL script contains forbidden keywords or functions after normalization"
      );
    }
  }
}

/**
 * Reject manifest- or user-supplied SQL that could escape the SQL API (dot-commands, ATTACH, VACUUM, extensions).
 */
export function assertSafeSqlScript(script: string): void {
  forEachSqlLineOutsideStrings(script, (line, lineNumber) => {
    if (lineLooksLikeDotCommand(line)) {
      throw new UnsafeSqlScriptError(
        `SQL script line ${lineNumber}: sqlite dot-commands are not allowed`
      );
    }
  });

  const normalized = normalizeSqlForSafetyAnalysis(script);
  assertNormalizedForbiddenTokens(normalized);

  for (const statement of splitSqlStatements(normalized)) {
    assertStatementAllowed(statement);
  }
}

export const SQLITE_PYTHON_EXECUTESCRIPT = [
  "import sqlite3, sys",
  "db_path = sys.argv[1]",
  "sql = sys.stdin.read()",
  `timeout = int(sys.argv[2]) if len(sys.argv) > 2 else ${20}`,
  "conn = sqlite3.connect(db_path, timeout=timeout)",
  "conn.enable_load_extension(False)",
  "try:",
  "    conn.executescript(sql)",
  "    conn.commit()",
  "finally:",
  "    conn.close()",
].join("\n");
