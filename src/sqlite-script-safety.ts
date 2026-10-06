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

const LITERAL_PLACEHOLDER = " ";

export class UnsafeSqlScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSqlScriptError";
  }
}

function stripUnicodeFormatChars(text: string): string {
  return text.replace(/\p{Cf}/gu, "");
}

function isHexDigit(ch: string): boolean {
  return /[0-9a-f]/i.test(ch);
}

/**
 * Replace SQL literal contents with placeholders so `;`, keywords, and comments inside
 * user data do not affect safety analysis. Supports '', X'..', "...", `...`, and [...] identifiers.
 */
export function maskSqlLiterals(script: string): string {
  let out = "";
  let i = 0;
  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];

    if (ch === "'") {
      out += "'";
      i++;
      let closed = false;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "'") {
          if (script[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i++;
          closed = true;
          break;
        }
        out += LITERAL_PLACEHOLDER;
        i++;
      }
      if (!closed) {
        throw new UnsafeSqlScriptError("SQL script contains an unterminated string literal");
      }
      continue;
    }

    if ((ch === "X" || ch === "x") && next === "'") {
      out += "X'";
      i += 2;
      let closed = false;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "'") {
          out += "'";
          i++;
          closed = true;
          break;
        }
        if (!isHexDigit(c)) {
          throw new UnsafeSqlScriptError("SQL script contains invalid X'...' blob literal");
        }
        out += LITERAL_PLACEHOLDER;
        i++;
      }
      if (!closed) {
        throw new UnsafeSqlScriptError("SQL script contains an unterminated X'...' blob literal");
      }
      continue;
    }

    if (ch === '"') {
      out += '"';
      i++;
      while (i < script.length) {
        const c = script[i]!;
        if (c === '"') {
          if (script[i + 1] === '"') {
            out += '""';
            i += 2;
            continue;
          }
          out += '"';
          i++;
          break;
        }
        out += LITERAL_PLACEHOLDER;
        i++;
      }
      if (!out.endsWith('"') || out.length < 2) {
        throw new UnsafeSqlScriptError("SQL script contains an unterminated double-quoted literal");
      }
      continue;
    }

    if (ch === "`") {
      out += "`";
      i++;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "`") {
          out += "`";
          i++;
          break;
        }
        out += LITERAL_PLACEHOLDER;
        i++;
      }
      if (!out.endsWith("`")) {
        throw new UnsafeSqlScriptError("SQL script contains an unterminated backtick-quoted literal");
      }
      continue;
    }

    if (ch === "[") {
      out += "[";
      i++;
      while (i < script.length) {
        const c = script[i]!;
        if (c === "]") {
          out += "]";
          i++;
          break;
        }
        out += LITERAL_PLACEHOLDER;
        i++;
      }
      if (!out.endsWith("]")) {
        throw new UnsafeSqlScriptError("SQL script contains an unterminated bracket-quoted identifier");
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Remove block and line comments entirely (no placeholder spaces). */
export function removeSqlComments(script: string): string {
  let out = "";
  let i = 0;
  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < script.length) {
        if (script[i] === "*" && script[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < script.length && script[i] !== "\n" && script[i] !== "\r") {
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Collapse whitespace after literals are masked and comments stripped. */
export function normalizeSqlForSafetyAnalysis(script: string): string {
  const stripped = stripUnicodeFormatChars(script);
  const masked = maskSqlLiterals(stripped);
  const withoutComments = removeSqlComments(masked);
  return withoutComments.replace(/\s+/g, " ").trim();
}

function lineLooksLikeDotCommand(line: string): boolean {
  const t = line.trimStart();
  return t.length > 0 && t.startsWith(".");
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
  const stripped = stripUnicodeFormatChars(script);
  const masked = maskSqlLiterals(stripped);

  const maskedLines = masked.split(/\r\n|\n|\r/);
  for (let lineNumber = 0; lineNumber < maskedLines.length; lineNumber++) {
    if (lineLooksLikeDotCommand(maskedLines[lineNumber]!)) {
      throw new UnsafeSqlScriptError(
        `SQL script line ${lineNumber + 1}: sqlite dot-commands are not allowed`
      );
    }
  }

  const withoutComments = removeSqlComments(masked);
  const normalized = withoutComments.replace(/\s+/g, " ").trim();
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
