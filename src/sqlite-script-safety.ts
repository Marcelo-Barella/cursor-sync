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

function lineHasForbiddenSqlKeyword(line: string): boolean {
  const stripped = line.replace(/--.*$/, "").trim();
  if (!stripped) {
    return false;
  }
  const lower = stripped.toLowerCase();
  if (/\b(attach|detach)\b/.test(lower)) {
    return true;
  }
  if (lower.includes("load_extension")) {
    return true;
  }
  const pragmaMatch = lower.match(/\bpragma\s+([a-z_]+)/i);
  if (pragmaMatch) {
    const name = pragmaMatch[1]!.toLowerCase();
    if (!ALLOWED_PRAGMA_NAMES.has(name)) {
      return true;
    }
  }
  return false;
}

export class UnsafeSqlScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeSqlScriptError";
  }
}

function lineLooksLikeDotCommand(line: string): boolean {
  const t = line.trimStart();
  return t.length > 0 && t.startsWith(".");
}

/** Split into logical lines, ignoring newlines inside single-quoted SQL string literals. */
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

/**
 * Reject manifest- or user-supplied SQL that could escape the SQL API (dot-commands, ATTACH, extensions).
 */
export function assertSafeSqlScript(script: string): void {
  forEachSqlLineOutsideStrings(script, (line, lineNumber) => {
    if (lineLooksLikeDotCommand(line)) {
      throw new UnsafeSqlScriptError(
        `SQL script line ${lineNumber}: sqlite dot-commands are not allowed`
      );
    }
    if (lineHasForbiddenSqlKeyword(line)) {
      throw new UnsafeSqlScriptError(
        `SQL script line ${lineNumber}: forbidden ATTACH/DETACH, load_extension, or PRAGMA`
      );
    }
  });
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
