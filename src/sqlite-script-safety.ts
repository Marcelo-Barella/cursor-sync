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

function isWordChar(ch: string): boolean {
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

/**
 * Single-pass SQLite-style lexer: comments and quoted regions share one state machine so
 * quotes inside comments never open fake literals.
 */
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
    while (j < script.length && script[j] !== "\n" && script[j] !== "\r") {
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
      if (ch === "\n" || ch === "\r") {
        flushWord(i);
        atLineStart = true;
        i++;
        continue;
      }
      if (atLineStart && (ch === " " || ch === "\t")) {
        i++;
        continue;
      }
      if (atLineStart && ch === ".") {
        const lineStart = i;
        let lineEnd = i;
        while (lineEnd < script.length && script[lineEnd] !== "\n" && script[lineEnd] !== "\r") {
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
      if (isWordChar(ch)) {
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
    if (/\s/.test(gap)) {
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

/** Build per-statement security surfaces (comments dropped, literals masked). */
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

/** Collapse whitespace after tokenization-based masking and comment stripping. */
export function normalizeSqlForSafetyAnalysis(script: string): string {
  const stripped = stripUnicodeFormatChars(script);
  const tokens = tokenizeSqlScript(stripped);
  const statements = buildStatementSecuritySurfaces(stripped, tokens);
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

/**
 * Reject manifest- or user-supplied SQL that could escape the SQL API (dot-commands, ATTACH, VACUUM, extensions).
 */
export function assertSafeSqlScript(script: string): void {
  const stripped = stripUnicodeFormatChars(script);
  const tokens = tokenizeSqlScript(stripped);
  const statements = buildStatementSecuritySurfaces(stripped, tokens);

  for (const statement of statements) {
    assertNormalizedForbiddenTokens(statement);
    assertStatementAllowed(statement);
  }
}

export const SQLITE_PYTHON_EXECUTESCRIPT = [
  "import re, sqlite3, sys",
  "db_path = sys.argv[1]",
  "sql = sys.stdin.read()",
  `timeout = int(sys.argv[2]) if len(sys.argv) > 2 else ${20}`,
  "ALLOWED_PRAGMAS = frozenset({",
  '    "busy_timeout", "wal_checkpoint", "user_version", "encoding",',
  '    "foreign_keys", "journal_mode", "synchronous", "temp_store",',
  "})",
  "FORBIDDEN_FUNCS = frozenset({",
  '    "load_extension", "writefile", "readfile", "edit", "fts3_tokenizer",',
  "})",
  "FORBIDDEN_STMT = re.compile(",
  '    r"\\b(attach|detach|vacuum)\\b", re.I',
  ")",
  "FORBIDDEN_CALL = re.compile(",
  '    r"\\b(load_extension|writefile|readfile|edit|fts3_tokenizer)\\s*\\(", re.I',
  ")",
  "",
  "def _authorizer(action, p1, p2, dbname, trigger):",
  "    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):",
  "        return sqlite3.SQLITE_DENY",
  "    if action == sqlite3.SQLITE_PRAGMA:",
  "        name = (p1 or '').split('(')[0].strip().lower()",
  "        if name not in ALLOWED_PRAGMAS:",
  "            return sqlite3.SQLITE_DENY",
  "    if action == sqlite3.SQLITE_FUNCTION:",
  "        if (p1 or '').lower() in FORBIDDEN_FUNCS:",
  "            return sqlite3.SQLITE_DENY",
  "    return sqlite3.SQLITE_OK",
  "",
  "def _split_statements(script):",
  "    out = []",
  "    buf = []",
  "    state = 'n'",
  "    i = 0",
  "    while i < len(script):",
  "        ch = script[i]",
  "        nxt = script[i + 1] if i + 1 < len(script) else ''",
  "        if state == 'n':",
  "            if ch == '-' and nxt == '-':",
  "                i += 2",
  "                while i < len(script) and script[i] not in '\\n\\r':",
  "                    i += 1",
  "                continue",
  "            if ch == '/' and nxt == '*':",
  "                i += 2",
  "                while i < len(script):",
  "                    if script[i] == '*' and i + 1 < len(script) and script[i + 1] == '/':",
  "                        i += 2",
  "                        break",
  "                    i += 1",
  "                else:",
  "                    i = len(script)",
  "                continue",
  "            if ch == \"'\":",
  "                state = 's'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch in 'Xx' and nxt == \"'\":",
  "                state = 'b'",
  "                buf.append(ch)",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'd'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == '`':",
  "                state = 't'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == '[':",
  "                state = 'k'",
  "                buf.append(ch)",
  "                i += 1",
  "                continue",
  "            if ch == ';':",
  "                stmt = ''.join(buf).strip()",
  "                if stmt:",
  "                    out.append(stmt)",
  "                buf = []",
  "                i += 1",
  "                continue",
  "            buf.append(ch)",
  "            i += 1",
  "            continue",
  "        if state == 's':",
  "            buf.append(ch)",
  "            if ch == \"'\" and nxt == \"'\":",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == \"'\":",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'b':",
  "            buf.append(ch)",
  "            if ch == \"'\":",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'd':",
  "            buf.append(ch)",
  "            if ch == '\"' and nxt == '\"':",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 't':",
  "            buf.append(ch)",
  "            if ch == '`' and nxt == '`':",
  "                buf.append(nxt)",
  "                i += 2",
  "                continue",
  "            if ch == '`':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "        if state == 'k':",
  "            buf.append(ch)",
  "            if ch == ']':",
  "                state = 'n'",
  "            i += 1",
  "            continue",
  "    tail = ''.join(buf).strip()",
  "    if tail:",
  "        out.append(tail)",
  "    return out",
  "",
  "def _security_surface(stmt):",
  "    surface = []",
  "    state = 'n'",
  "    word = []",
  "    prev_end = 0",
  "    i = 0",
  "    while i < len(stmt):",
  "        ch = stmt[i]",
  "        nxt = stmt[i + 1] if i + 1 < len(stmt) else ''",
  "        if state == 'n':",
  "            if ch == '-' and nxt == '-':",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                i += 2",
  "                while i < len(stmt) and stmt[i] not in '\\n\\r':",
  "                    i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch == '/' and nxt == '*':",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                i += 2",
  "                while i < len(stmt):",
  "                    if stmt[i] == '*' and i + 1 < len(stmt) and stmt[i + 1] == '/':",
  "                        i += 2",
  "                        break",
  "                    i += 1",
  "                else:",
  "                    i = len(stmt)",
  "                prev_end = i",
  "                continue",
  "            if ch == \"'\":",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                if prev_end < i and surface and re.search(r'\\s', stmt[prev_end:i]):",
  "                    surface.append(' ')",
  "                surface.append(' ')",
  "                state = 's'",
  "                i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch in 'Xx' and nxt == \"'\":",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                surface.append(' ')",
  "                state = 'b'",
  "                i += 2",
  "                prev_end = i",
  "                continue",
  "            if ch in ('\"', '`', '['):",
  "                if word:",
  "                    surface.append(''.join(word))",
  "                    word = []",
  "                if prev_end < i and surface and re.search(r'\\s', stmt[prev_end:i]):",
  "                    surface.append(' ')",
  "                surface.append(' ')",
  "                state = 'd' if ch == '\"' else ('t' if ch == '`' else 'k')",
  "                i += 1",
  "                prev_end = i",
  "                continue",
  "            if ch.isalnum() or ch == '_':",
  "                if prev_end < i and word and re.search(r'\\s', stmt[prev_end:i]):",
  "                    surface.append(''.join(word))",
  "                    surface.append(' ')",
  "                    word = []",
  "                if not word:",
  "                    word = [ch]",
  "                else:",
  "                    word.append(ch)",
  "                i += 1",
  "                continue",
  "            if word:",
  "                surface.append(''.join(word))",
  "                word = []",
  "            surface.append(ch)",
  "            i += 1",
  "            prev_end = i",
  "            continue",
  "        if state == 's':",
  "            if ch == \"'\" and nxt == \"'\":",
  "                i += 2",
  "                continue",
  "            if ch == \"'\":",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'b':",
  "            if ch == \"'\":",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'd':",
  "            if ch == '\"' and nxt == '\"':",
  "                i += 2",
  "                continue",
  "            if ch == '\"':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 't':",
  "            if ch == '`' and nxt == '`':",
  "                i += 2",
  "                continue",
  "            if ch == '`':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "        if state == 'k':",
  "            if ch == ']':",
  "                state = 'n'",
  "                prev_end = i + 1",
  "            i += 1",
  "            continue",
  "    if word:",
  "        surface.append(''.join(word))",
  "    return re.sub(r'\\s+', ' ', ''.join(surface)).strip()",
  "",
  "def _refuse_unsafe_statement(stmt):",
  "    surface = _security_surface(stmt)",
  "    if FORBIDDEN_STMT.search(surface) or FORBIDDEN_CALL.search(surface):",
  "        raise sqlite3.OperationalError('refused unsafe SQL statement')",
  "",
  "conn = sqlite3.connect(db_path, timeout=timeout)",
  "conn.enable_load_extension(False)",
  "conn.set_authorizer(_authorizer)",
  "if hasattr(sqlite3, 'SQLITE_LIMIT_ATTACHED'):",
  "    conn.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)",
  "try:",
  "    for stmt in _split_statements(sql):",
  "        _refuse_unsafe_statement(stmt)",
  "        conn.execute(stmt)",
  "    conn.commit()",
  "finally:",
  "    conn.close()",
].join("\n");
