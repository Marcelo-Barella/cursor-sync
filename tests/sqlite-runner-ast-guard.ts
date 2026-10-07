import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { collectSourceFiles, scriptKindFor } from "./sync-path-ast-guard.js";

const SQLITE_SCRIPT = "SQLITE_PYTHON_EXECUTESCRIPT";
const RUN_SQLITE_SCRIPT = "runSqliteScript";
const EXEC_STDIN = "execFileWithStdinAsync";
const SAFE_ASSERT = "assertSafeSqlScript";
const READ_ONLY_ASSERT = "assertReadOnlySqliteQuery";
const CLI_SAFE_STDIN = "runSqliteCliSafeStdin";
const RUN_SQLITE_QUERY = "runSqliteQuery";
const EXEC_FILE = "execFileAsync";

function isInsideNamedFunction(node: ts.Node, name: string): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === name) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isInsideRunSqliteCliSafeStdin(node: ts.Node): boolean {
  return isInsideNamedFunction(node, CLI_SAFE_STDIN);
}

function isInsideRunSqliteScript(node: ts.Node): boolean {
  return isInsideNamedFunction(node, RUN_SQLITE_SCRIPT);
}

function execCalleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.name) &&
    node.expression.name.text === EXEC_STDIN
  ) {
    return EXEC_STDIN;
  }
  return undefined;
}

function expressionUsesExecStdin(expr: ts.Expression, known: Set<string>): boolean {
  if (ts.isIdentifier(expr) && (known.has(expr.text) || expr.text === EXEC_STDIN)) {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === EXEC_STDIN
  );
}

function collectExecStdinLocalNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>([EXEC_STDIN]);
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === EXEC_STDIN && !names.has(el.name.text)) {
              names.add(el.name.text);
              grew = true;
            }
          }
        }
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer) {
          if (expressionUsesExecStdin(node.initializer, names) && !names.has(node.name.text)) {
            names.add(node.name.text);
            grew = true;
          }
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop) && prop.text === EXEC_STDIN && ts.isIdentifier(el.name)) {
              if (!names.has(el.name.text)) {
                names.add(el.name.text);
                grew = true;
              }
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        expressionUsesExecStdin(node.right, names) &&
        !names.has(node.left.text)
      ) {
        names.add(node.left.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function collectExecFileAsyncLocalNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>([EXEC_FILE]);
  let grew = true;
  while (grew) {
    grew = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === EXEC_FILE && !names.has(el.name.text)) {
              names.add(el.name.text);
              grew = true;
            }
          }
        }
      }
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer) {
          if (
            ts.isIdentifier(node.initializer) &&
            names.has(node.initializer.text) &&
            !names.has(node.name.text)
          ) {
            names.add(node.name.text);
            grew = true;
          }
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop) && prop.text === EXEC_FILE && ts.isIdentifier(el.name)) {
              if (!names.has(el.name.text)) {
                names.add(el.name.text);
                grew = true;
              }
            }
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        ts.isIdentifier(node.right) &&
        names.has(node.right.text) &&
        !names.has(node.left.text)
      ) {
        names.add(node.left.text);
        grew = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function catchClauseRethrows(clause: ts.CatchClause): boolean {
  if (!clause.block) {
    return false;
  }
  let rethrows = false;
  const walk = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) {
      rethrows = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(clause.block);
  return rethrows;
}

function assertCallIsUnconditional(assertCall: ts.CallExpression, fnBody: ts.Node): boolean {
  let current: ts.Node | undefined = assertCall.parent;
  while (current && current !== fnBody) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current)
    ) {
      return false;
    }
    if (ts.isTryStatement(current)) {
      const tryBlock = current.tryBlock;
      if (assertCall.getStart() >= tryBlock.getStart() && assertCall.getEnd() <= tryBlock.getEnd()) {
        for (const clause of current.catchClause ? [current.catchClause] : []) {
          if (clause && !catchClauseRethrows(clause)) {
            return false;
          }
        }
      }
    }
    current = current.parent;
  }
  return true;
}

function isExecFileAsyncCall(node: ts.CallExpression, localNames: Set<string>): boolean {
  return ts.isIdentifier(node.expression) && localNames.has(node.expression.text);
}

function isExecStdinCall(node: ts.CallExpression, localNames: Set<string>): boolean {
  if (ts.isIdentifier(node.expression) && localNames.has(node.expression.text)) {
    return true;
  }
  if (execCalleeName(node) === EXEC_STDIN) {
    return true;
  }
  return false;
}

function functionHasUnconditionalAssertBeforeExec(
  body: ts.ConciseBody,
  localNames: Set<string>,
  assertName: string,
  isExec: (node: ts.CallExpression) => boolean
): { ok: boolean; reason?: string } {
  const marks: Array<{ kind: "assert" | "exec"; pos: number; node?: ts.CallExpression }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === assertName
    ) {
      if (!assertCallIsUnconditional(node, body)) {
        marks.push({ kind: "assert", pos: node.getStart(), node });
      } else {
        marks.push({ kind: "assert", pos: node.getStart(), node });
      }
    }
    if (ts.isCallExpression(node) && isExec(node)) {
      marks.push({ kind: "exec", pos: node.getStart() });
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  for (const m of marks) {
    if (m.kind === "assert" && m.node && !assertCallIsUnconditional(m.node, body)) {
      return { ok: false, reason: `${assertName} must be unconditional before subprocess SQL` };
    }
  }
  const firstExec = marks.find((m) => m.kind === "exec");
  const firstAssert = marks.find((m) => m.kind === "assert");
  if (firstExec && (!firstAssert || firstAssert.pos > firstExec.pos)) {
    return { ok: false, reason: `must call ${assertName} before exec` };
  }
  if (firstExec && !firstAssert) {
    return { ok: false, reason: `must call ${assertName} before exec` };
  }
  return { ok: true };
}

function namedFunctionsRequireAssertBeforeExec(
  source: ts.SourceFile,
  rel: string,
  offenders: string[],
  specs: Array<{ name: string; assertName: string; isExec: (n: ts.CallExpression) => boolean }>
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const fnName = node.name.text;
      const spec = specs.find((s) => s.name === fnName);
      if (spec && node.body) {
        const result = functionHasUnconditionalAssertBeforeExec(
          node.body,
          new Set(),
          spec.assertName,
          spec.isExec
        );
        if (!result.ok) {
          offenders.push(`${rel}: ${fnName} ${result.reason}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanExportedWritersWithoutAssert(source: ts.SourceFile, rel: string, offenders: string[]): void {
  if (rel !== "src/transcripts-sqlite.ts") {
    return;
  }
  const localNames = collectExecStdinLocalNames(source);
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      hasExportModifier(node)
    ) {
      const fnName = node.name.text;
      if (fnName === RUN_SQLITE_SCRIPT || fnName === CLI_SAFE_STDIN) {
        ts.forEachChild(node, visit);
        return;
      }
      let hasExec = false;
      let hasAssert = false;
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && isExecStdinCall(inner, localNames)) {
          hasExec = true;
        }
        if (
          ts.isCallExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === SAFE_ASSERT
        ) {
          hasAssert = true;
        }
        if (
          ts.isCallExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === RUN_SQLITE_SCRIPT
        ) {
          hasExec = true;
          hasAssert = true;
        }
        ts.forEachChild(inner, walk);
      };
      walk(node.body);
      if (hasExec && !hasAssert) {
        offenders.push(
          `${rel}: exported ${fnName} must use ${SAFE_ASSERT} before subprocess SQL writes`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function verifyRunSqliteQueryReadPathDefense(
  source: ts.SourceFile,
  rel: string,
  offenders: string[]
): void {
  let fnBody: ts.ConciseBody | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === RUN_SQLITE_QUERY && node.body) {
      fnBody = node.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!fnBody) {
    offenders.push(`${rel}: ${RUN_SQLITE_QUERY} not found`);
    return;
  }
  const text = fnBody.getText(source);
  if (!text.includes('"-readonly"') && !text.includes("'-readonly'")) {
    offenders.push(`${rel}: ${RUN_SQLITE_QUERY} must pass -readonly to sqlite3 CLI`);
  }
  if (!text.includes("sqlite3CliSupportsSafeFlag")) {
    offenders.push(
      `${rel}: ${RUN_SQLITE_QUERY} must gate CLI use on sqlite3CliSupportsSafeFlag`
    );
  }
  if (!text.includes("runPythonSqliteQuery")) {
    offenders.push(`${rel}: ${RUN_SQLITE_QUERY} must fall back to runPythonSqliteQuery`);
  }
}

function hasExportModifier(node: ts.FunctionDeclaration): boolean {
  return (
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

function scanSourceFile(rel: string, content: string, offenders: string[]): void {
  const source = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(rel)
  );

  const localNames = collectExecStdinLocalNames(source);

  if (rel === "src/transcripts-sqlite.ts") {
    const stdinNames = collectExecStdinLocalNames(source);
    const fileNames = collectExecFileAsyncLocalNames(source);
    namedFunctionsRequireAssertBeforeExec(source, rel, offenders, [
      {
        name: RUN_SQLITE_SCRIPT,
        assertName: SAFE_ASSERT,
        isExec: (n) => isExecStdinCall(n, stdinNames),
      },
      {
        name: CLI_SAFE_STDIN,
        assertName: SAFE_ASSERT,
        isExec: (n) => isExecStdinCall(n, stdinNames),
      },
      {
        name: RUN_SQLITE_QUERY,
        assertName: READ_ONLY_ASSERT,
        isExec: (n) => isExecFileAsyncCall(n, fileNames),
      },
    ]);
    scanExportedWritersWithoutAssert(source, rel, offenders);
    verifyRunSqliteQueryReadPathDefense(source, rel, offenders);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === SQLITE_SCRIPT) {
            offenders.push(`${rel}: must not import ${SQLITE_SCRIPT}`);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (name === SQLITE_SCRIPT || name === "resolvePythonInterpreterForSqlite") {
          offenders.push(`${rel}: must not re-export ${name}`);
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      node.text === SQLITE_SCRIPT &&
      !ts.isVariableDeclaration(node.parent)
    ) {
      if (rel !== "src/transcripts-sqlite.ts") {
        offenders.push(`${rel}: references ${SQLITE_SCRIPT}`);
      } else if (!isInsideRunSqliteScript(node)) {
        offenders.push(`${rel}: ${SQLITE_SCRIPT} reference outside ${RUN_SQLITE_SCRIPT}`);
      }
    }

    if (ts.isCallExpression(node) && isExecStdinCall(node, localNames)) {
      if (rel !== "src/transcripts-sqlite.ts") {
        offenders.push(`${rel}: ${EXEC_STDIN} call outside transcripts-sqlite.ts`);
      } else {
        const inRunSqlite = isInsideRunSqliteScript(node);
        const inCliSafe = isInsideRunSqliteCliSafeStdin(node);
        if (!inRunSqlite && !inCliSafe) {
          offenders.push(
            `${rel}: ${EXEC_STDIN} must be inside ${RUN_SQLITE_SCRIPT} or ${CLI_SAFE_STDIN}`
          );
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      node.text === "resolvePythonInterpreterForSqlite" &&
      rel !== "src/transcripts-sqlite.ts"
    ) {
      offenders.push(`${rel}: references resolvePythonInterpreterForSqlite`);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

function stringFromArrayInitializer(node: ts.Expression): string | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "join"
  ) {
    return undefined;
  }
  const arr = node.expression.expression;
  if (!ts.isArrayLiteralExpression(arr)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const el of arr.elements) {
    if (ts.isStringLiteral(el)) {
      parts.push(el.text);
    } else if (ts.isNoSubstitutionTemplateLiteral(el)) {
      parts.push(el.text);
    } else if (ts.isTemplateExpression(el)) {
      let chunk = el.head.text;
      for (const span of el.templateSpans) {
        if (ts.isIdentifier(span.expression)) {
          chunk += span.expression.text;
        } else if (ts.isNumericLiteral(span.expression)) {
          chunk += span.expression.text;
        }
        chunk += span.literal.text;
      }
      parts.push(chunk);
    }
  }
  const sep =
    node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      ? node.arguments[0].text
      : "\n";
  return parts.join(sep);
}

export function extractSqlitePythonExecutescriptFromTranscriptsSource(
  content: string
): string | undefined {
  const source = ts.createSourceFile(
    "transcripts-sqlite.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor("transcripts-sqlite.ts")
  );
  let value: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === SQLITE_SCRIPT && node.initializer) {
        value = stringFromArrayInitializer(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return value;
}

export function scanSqliteRunnerViolationsFromText(
  rel: string,
  content: string
): string[] {
  const offenders: string[] = [];
  scanSourceFile(rel.replace(/\\/g, "/"), content, offenders);
  return offenders;
}

export function scanSqliteRunnerViolations(repoRoot: string): string[] {
  const srcDir = path.join(repoRoot, "src");
  const offenders: string[] = [];
  for (const rel of collectSourceFiles(srcDir)) {
    const abs = path.join(repoRoot, rel);
    const content = fs.readFileSync(abs, "utf8");
    scanSourceFile(rel.replace(/\\/g, "/"), content, offenders);
  }
  return offenders;
}
