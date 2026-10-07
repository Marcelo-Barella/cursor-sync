import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { collectSourceFiles, scriptKindFor } from "./sync-path-ast-guard.js";

const SQLITE_SCRIPT = "SQLITE_PYTHON_EXECUTESCRIPT";
const RUN_SQLITE_SCRIPT = "runSqliteScript";
const EXEC_STDIN = "execFileWithStdinAsync";
const SAFE_ASSERT = "assertSafeSqlScript";
const CLI_SAFE_STDIN = "runSqliteCliSafeStdin";

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

function collectExecStdinLocalNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>([EXEC_STDIN]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === EXEC_STDIN) {
            names.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
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

function functionHasAssertBeforeExec(
  body: ts.ConciseBody,
  localNames: Set<string>
): boolean {
  const marks: Array<{ kind: "assert" | "exec"; pos: number }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SAFE_ASSERT
    ) {
      marks.push({ kind: "assert", pos: node.getStart() });
    }
    if (ts.isCallExpression(node) && isExecStdinCall(node, localNames)) {
      marks.push({ kind: "exec", pos: node.getStart() });
    }
    ts.forEachChild(node, walk);
  };
  if (ts.isBlock(body)) {
    walk(body);
  } else {
    walk(body);
  }
  const firstExec = marks.find((m) => m.kind === "exec");
  const firstAssert = marks.find((m) => m.kind === "assert");
  if (firstExec && (!firstAssert || firstAssert.pos > firstExec.pos)) {
    return false;
  }
  return true;
}

function namedFunctionsRequireAssertBeforeExec(
  source: ts.SourceFile,
  rel: string,
  offenders: string[],
  names: string[]
): void {
  const localNames = collectExecStdinLocalNames(source);
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      if (node.body && !functionHasAssertBeforeExec(node.body, localNames)) {
        offenders.push(
          `${rel}: ${node.name.text} must call ${SAFE_ASSERT} before ${EXEC_STDIN}`
        );
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
    namedFunctionsRequireAssertBeforeExec(source, rel, offenders, [
      RUN_SQLITE_SCRIPT,
      CLI_SAFE_STDIN,
    ]);
    scanExportedWritersWithoutAssert(source, rel, offenders);
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
