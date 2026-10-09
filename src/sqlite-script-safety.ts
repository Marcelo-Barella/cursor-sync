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

const UNICODE_FORMAT_CHAR_RE = /\p{Cf}/u;

function isHexDigit(ch: string): boolean {
  return /[0-9a-f]/i.test(ch);
}

function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

function rejectNonAsciiOrFormatOutsideSingleQuotedLiteral(ch: string): void {
  if (ch.length !== 1) {
    return;
  }
  const code = ch.charCodeAt(0);
  if (code > 0x7f || UNICODE_FORMAT_CHAR_RE.test(ch)) {
    throw new UnsafeSqlScriptError(
      "SQL script contains non-ASCII or format characters outside string literals"
    );
  }
}

function isAsciiIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

type SqlTokenKind = "comment" | "semicolon" | "word" | "literal" | "other";

interface SqlToken {
  kind: SqlTokenKind;
  start: number;
  end: number;
  text?: string;
}

enum LexState {
  Normal,
  LineComment,
  BlockComment,
  SingleQuote,
  BlobQuote,
  DoubleQuote,
  BacktickQuote,
  BracketQuote,
}

function throwUnterminated(kind: string): never {
  throw new UnsafeSqlScriptError(`SQL script contains an unterminated ${kind}`);
}

export function tokenizeSqlScript(script: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  let state = LexState.Normal;
  let atLineStart = true;
  let wordStart = -1;

  const flushWord = (end: number): void => {
    if (wordStart >= 0) {
      tokens.push({
        kind: "word",
        start: wordStart,
        end,
        text: script.slice(wordStart, end),
      });
      wordStart = -1;
    }
  };

  const consumeLineComment = (start: number): number => {
    let j = start + 2;
    while (j < script.length && script[j] !== "\n") {
      j++;
    }
    tokens.push({ kind: "comment", start, end: j });
    return j;
  };

  const consumeBlockComment = (start: number): number => {
    let j = start + 2;
    while (j < script.length) {
      if (script[j] === "*" && script[j + 1] === "/") {
        j += 2;
        tokens.push({ kind: "comment", start, end: j });
        return j;
      }
      j++;
    }
    tokens.push({ kind: "comment", start, end: script.length });
    return script.length;
  };

  const failDotCommandLine = (lineStart: number, lineEnd: number): void => {
    const line = script.slice(lineStart, lineEnd);
    const trimmed = line.trimStart();
    if (trimmed.length > 0 && trimmed.startsWith(".")) {
      let lineNumber = 1;
      for (let k = 0; k < lineStart; k++) {
        if (script[k] === "\n") {
          lineNumber++;
        }
      }
      throw new UnsafeSqlScriptError(
        `SQL script line ${lineNumber}: sqlite dot-commands are not allowed`
      );
    }
  };

  while (i < script.length) {
    const ch = script[i]!;
    const next = script[i + 1];

    if (state === LexState.Normal) {
      rejectNonAsciiOrFormatOutsideSingleQuotedLiteral(ch);
      if (isAsciiWhitespace(ch)) {
        flushWord(i);
        if (atLineStart && (ch === " " || ch === "\t")) {
          i++;
          continue;
        }
        if (ch === "\n") {
          atLineStart = true;
        } else if (ch !== "\r") {
          atLineStart = false;
        }
        i++;
        continue;
      }
      if (atLineStart && ch === ".") {
        const lineStart = i;
        let lineEnd = i;
        while (lineEnd < script.length && script[lineEnd] !== "\n") {
          lineEnd++;
        }
        failDotCommandLine(lineStart, lineEnd);
      }
      if (ch === "-" && next === "-") {
        flushWord(i);
        i = consumeLineComment(i);
        atLineStart = false;
        continue;
      }
      if (ch === "/" && next === "*") {
        flushWord(i);
        i = consumeBlockComment(i);
        atLineStart = false;
        continue;
      }
      if (ch === "'") {
        flushWord(i);
        tokens.push({ kind: "literal", start: i, end: i + 1 });
        state = LexState.SingleQuote;
        i++;
        atLineStart = false;
        continue;
      }
      if ((ch === "X" || ch === "x") && next === "'") {
        flushWord(i);
        tokens.push({ kind: "literal", start: i, end: i + 2 });
        state = LexState.BlobQuote;
        i += 2;
        atLineStart = false;
        continue;
      }
      if (ch === '"') {
        flushWord(i);
        tokens.push({ kind: "literal", start: i, end: i + 1 });
        state = LexState.DoubleQuote;
        i++;
        atLineStart = false;
        continue;
      }
      if (ch === "`") {
        flushWord(i);
        tokens.push({ kind: "literal", start: i, end: i + 1 });
        state = LexState.BacktickQuote;
        i++;
        atLineStart = false;
        continue;
      }
      if (ch === "[") {
        flushWord(i);
        tokens.push({ kind: "literal", start: i, end: i + 1 });
        state = LexState.BracketQuote;
        i++;
        atLineStart = false;
        continue;
      }
      if (ch === ";") {
        flushWord(i);
        tokens.push({ kind: "semicolon", start: i, end: i + 1 });
        i++;
        atLineStart = false;
        continue;
      }
      if (isAsciiIdentifierChar(ch)) {
        if (wordStart < 0) {
          wordStart = i;
        }
        i++;
        atLineStart = false;
        continue;
      }
      flushWord(i);
      tokens.push({ kind: "other", start: i, end: i + 1, text: ch });
      i++;
      atLineStart = false;
      continue;
    }

    if (state === LexState.SingleQuote) {
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        const last = tokens[tokens.length - 1];
        if (last?.kind === "literal") {
          last.end = i + 1;
        }
        state = LexState.Normal;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === LexState.BlobQuote) {
      if (ch === "'") {
        const last = tokens[tokens.length - 1];
        if (last?.kind === "literal") {
          last.end = i + 1;
        }
        state = LexState.Normal;
        i++;
        continue;
      }
      if (!isHexDigit(ch)) {
        throw new UnsafeSqlScriptError("SQL script contains invalid X'...' blob literal");
      }
      i++;
      continue;
    }

    if (state === LexState.DoubleQuote) {
      rejectNonAsciiOrFormatOutsideSingleQuotedLiteral(ch);
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          continue;
        }
        const last = tokens[tokens.length - 1];
        if (last?.kind === "literal") {
          last.end = i + 1;
        }
        state = LexState.Normal;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === LexState.BacktickQuote) {
      rejectNonAsciiOrFormatOutsideSingleQuotedLiteral(ch);
      if (ch === "`") {
        if (next === "`") {
          i += 2;
          continue;
        }
        const last = tokens[tokens.length - 1];
        if (last?.kind === "literal") {
          last.end = i + 1;
        }
        state = LexState.Normal;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === LexState.BracketQuote) {
      rejectNonAsciiOrFormatOutsideSingleQuotedLiteral(ch);
      if (ch === "]") {
        const last = tokens[tokens.length - 1];
        if (last?.kind === "literal") {
          last.end = i + 1;
        }
        state = LexState.Normal;
        i++;
        continue;
      }
      i++;
      continue;
    }
  }

  flushWord(script.length);

  if (state === LexState.SingleQuote) {
    throwUnterminated("string literal");
  }
  if (state === LexState.BlobQuote) {
    throwUnterminated("X'...' blob literal");
  }
  if (state === LexState.DoubleQuote) {
    throwUnterminated("double-quoted literal");
  }
  if (state === LexState.BacktickQuote) {
    throwUnterminated("backtick-quoted literal");
  }
  if (state === LexState.BracketQuote) {
    throwUnterminated("bracket-quoted identifier");
  }

  return tokens;
}

function appendTokenToSurface(
  script: string,
  token: SqlToken,
  surface: string,
  prevEnd: number
): { surface: string; prevEnd: number } {
  if (token.kind === "comment") {
    return { surface, prevEnd: token.end };
  }
  if (prevEnd > 0 && token.start > prevEnd) {
    const gap = script.slice(prevEnd, token.start);
    if (/[ \t\n\f\r]/.test(gap)) {
      surface += " ";
    }
  }
  if (token.kind === "literal") {
    surface += LITERAL_PLACEHOLDER;
  } else if (token.kind === "word") {
    surface += token.text ?? "";
  } else if (token.kind === "other") {
    surface += token.text ?? "";
  } else if (token.kind === "semicolon") {
    surface += ";";
  }
  return { surface, prevEnd: token.end };
}

export function buildStatementSecuritySurfaces(script: string, tokens: SqlToken[]): string[] {
  const statements: string[] = [];
  let current = "";
  let prevEnd = 0;

  for (const token of tokens) {
    if (token.kind === "semicolon") {
      const trimmed = current.replace(/\s+/g, " ").trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      prevEnd = token.end;
      continue;
    }
    const next = appendTokenToSurface(script, token, current, prevEnd);
    current = next.surface;
    prevEnd = next.prevEnd;
  }
  const trimmed = current.replace(/\s+/g, " ").trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }
  return statements;
}

/** @deprecated Use tokenizeSqlScript; kept for tests that snapshot masking behavior. */
export function maskSqlLiterals(script: string): string {
  const tokens = tokenizeSqlScript(script);
  let out = "";
  let prevEnd = 0;
  for (const token of tokens) {
    if (token.kind === "comment") {
      continue;
    }
    if (prevEnd < token.start) {
      out += script.slice(prevEnd, token.start);
    }
    if (token.kind === "literal") {
      out += LITERAL_PLACEHOLDER.repeat(Math.max(1, token.end - token.start - 2));
      out += script[token.end - 1] ?? "";
    } else if (token.kind === "word") {
      out += token.text ?? "";
    } else if (token.kind === "other") {
      out += token.text ?? "";
    } else if (token.kind === "semicolon") {
      out += ";";
    }
    prevEnd = token.end;
  }
  if (prevEnd < script.length) {
    out += script.slice(prevEnd);
  }
  return out;
}

/** @deprecated Use tokenizeSqlScript. */
export function removeSqlComments(script: string): string {
  const tokens = tokenizeSqlScript(script);
  let out = "";
  let prevEnd = 0;
  for (const token of tokens) {
    if (token.kind === "comment") {
      if (prevEnd < token.start) {
        out += script.slice(prevEnd, token.start);
      }
      prevEnd = token.end;
      continue;
    }
    if (prevEnd < token.start) {
      out += script.slice(prevEnd, token.start);
    }
    if (token.kind === "word") {
      out += token.text ?? "";
    } else if (token.kind === "other") {
      out += token.text ?? "";
    } else if (token.kind === "literal") {
      out += script.slice(token.start, token.end);
    } else if (token.kind === "semicolon") {
      out += ";";
    }
    prevEnd = token.end;
  }
  if (prevEnd < script.length) {
    out += script.slice(prevEnd);
  }
  return out;
}

export function normalizeSqlForSafetyAnalysis(script: string): string {
  const tokens = tokenizeSqlScript(script);
  const statements = buildStatementSecuritySurfaces(script, tokens);
  return statements.join(" ; ").replace(/\s+/g, " ").trim();
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

export function assertValidSqlScriptUnicode(script: string): void {
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = script.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new UnsafeSqlScriptError("SQL script contains a lone UTF-16 surrogate");
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = script.charCodeAt(i - 1);
      if (prev < 0xd800 || prev > 0xdbff) {
        throw new UnsafeSqlScriptError("SQL script contains a lone UTF-16 surrogate");
      }
    }
  }
}

export function assertSafeSqlScript(script: string): void {
  assertValidSqlScriptUnicode(script);
  const tokens = tokenizeSqlScript(script);
  const statements = buildStatementSecuritySurfaces(script, tokens);

  for (const statement of statements) {
    assertNormalizedForbiddenTokens(statement);
    assertStatementAllowed(statement);
  }
}

const READ_ONLY_QUERY_KEYWORDS = new Set(["select", "pragma"]);

const READ_ONLY_PRAGMA_NAMES_CALLERS = new Set(["user_version", "table_info"]);

const READ_ONLY_FORBIDDEN_FUNCTIONS = new Set([
  "writefile",
  "readfile",
  "edit",
  "load_extension",
  "fts3_tokenizer",
  "sqlite_dbpage",
  "lsdir",
  "zipfile",
  "sqlar",
  "fsdir",
  "uintreg",
  "intreg",
  "series",
  "generate_series",
]);

function extractQuotedIdentifier(sql: string, token: SqlToken): string | undefined {
  const slice = sql.slice(token.start, token.end);
  const first = slice[0];
  if (first === '"') {
    return slice.slice(1, -1).replace(/""/g, '"');
  }
  if (first === "`") {
    return slice.slice(1, -1).replace(/``/g, "`");
  }
  if (first === "[") {
    return slice.slice(1, -1);
  }
  return undefined;
}

function isForbiddenReadOnlyFunction(name: string): boolean {
  const lower = name.toLowerCase();
  if (READ_ONLY_FORBIDDEN_FUNCTIONS.has(lower)) {
    return true;
  }
  return lower.startsWith("sqlar_");
}

function indexOfNextOpenParen(tokens: SqlToken[], from: number): number {
  for (let k = from; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (tok.kind === "comment") {
      continue;
    }
    if (tok.kind === "other" && tok.text === "(") {
      return k;
    }
    if (tok.kind === "word" || tok.kind === "literal" || tok.kind === "semicolon") {
      return -1;
    }
  }
  return -1;
}

function assertNoForbiddenReadOnlyCalls(sql: string, tokens: SqlToken[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "comment" || t.kind === "semicolon") {
      continue;
    }
    let callee: string | undefined;
    if (t.kind === "word") {
      callee = t.text ?? "";
    } else if (t.kind === "literal") {
      callee = extractQuotedIdentifier(sql, t);
    } else {
      continue;
    }
    if (!callee) {
      continue;
    }
    if (indexOfNextOpenParen(tokens, i + 1) < 0) {
      continue;
    }
    if (isForbiddenReadOnlyFunction(callee)) {
      throw new UnsafeSqlScriptError(
        `read-only query cannot call shell function ${callee.toLowerCase()}`
      );
    }
  }
}

function assertReadOnlyPragma(sql: string, tokens: SqlToken[], statement: string): void {
  if (statement.includes("=")) {
    throw new UnsafeSqlScriptError("read-only PRAGMA cannot assign values");
  }
  let i = 0;
  while (
    i < tokens.length &&
    !(tokens[i]!.kind === "word" && tokens[i]!.text?.toLowerCase() === "pragma")
  ) {
    i++;
  }
  if (i >= tokens.length) {
    throw new UnsafeSqlScriptError("read-only PRAGMA statement is malformed");
  }
  i++;
  while (i < tokens.length && tokens[i]!.kind === "comment") {
    i++;
  }
  const nameTok = tokens[i];
  let name: string | undefined;
  if (nameTok?.kind === "word") {
    name = nameTok.text?.toLowerCase();
  } else if (nameTok?.kind === "literal") {
    name = extractQuotedIdentifier(sql, nameTok)?.toLowerCase();
  }
  if (!name || !READ_ONLY_PRAGMA_NAMES_CALLERS.has(name)) {
    throw new UnsafeSqlScriptError(
      `PRAGMA ${name ?? "(unknown)"} is not allowlisted for read-only query`
    );
  }
  if (name === "user_version" && /\buser_version\s*\(/i.test(statement)) {
    throw new UnsafeSqlScriptError("read-only PRAGMA user_version cannot use call syntax");
  }
}

export function assertReadOnlySqliteQuery(sql: string): void {
  assertValidSqlScriptUnicode(sql);
  const tokens = tokenizeSqlScript(sql);
  const statements = buildStatementSecuritySurfaces(sql, tokens);
  if (statements.length === 0) {
    throw new UnsafeSqlScriptError("read-only SQLite query is empty");
  }
  if (statements.length > 1) {
    throw new UnsafeSqlScriptError("read-only SQLite query must be a single statement");
  }
  const statement = statements[0]!;
  assertNormalizedForbiddenTokens(statement);
  assertNoForbiddenReadOnlyCalls(sql, tokens);
  const keyword = leadingStatementKeyword(statement);
  if (!keyword || !READ_ONLY_QUERY_KEYWORDS.has(keyword)) {
    throw new UnsafeSqlScriptError(
      `read-only SQLite query must be SELECT or allowlisted PRAGMA (got ${keyword ?? "unknown"})`
    );
  }
  if (keyword === "pragma") {
    assertReadOnlyPragma(sql, tokens, statement);
  }
}


