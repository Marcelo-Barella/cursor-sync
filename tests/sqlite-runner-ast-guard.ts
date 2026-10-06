import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { collectSourceFiles, scriptKindFor } from "./sync-path-ast-guard.js";

const SQLITE_SCRIPT = "SQLITE_PYTHON_EXECUTESCRIPT";
const RUN_SQLITE_SCRIPT = "runSqliteScript";
const EXEC_STDIN = "execFileWithStdinAsync";
const SAFE_ASSERT = "assertSafeSqlScript";

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
  return isInsideNamedFunction(node, "runSqliteCliSafeStdin");
}

function runSqliteScriptHasSafetyBeforeExec(source: ts.SourceFile): string | undefined {
  let runFn: ts.FunctionDeclaration | undefined;
  const visitFind = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === RUN_SQLITE_SCRIPT) {
      runFn = node;
      return;
    }
    ts.forEachChild(node, visitFind);
  };
  visitFind(source);
  if (!runFn?.body) {
    return `${RUN_SQLITE_SCRIPT} not found`;
  }
  const marks: Array<{ kind: "assert" | "exec"; pos: number }> = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SAFE_ASSERT
    ) {
      marks.push({ kind: "assert", pos: node.getStart() });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === EXEC_STDIN
    ) {
      marks.push({ kind: "exec", pos: node.getStart() });
    }
    ts.forEachChild(node, walk);
  };
  walk(runFn.body);
  const firstExec = marks.find((m) => m.kind === "exec");
  const firstAssert = marks.find((m) => m.kind === "assert");
  if (firstExec && (!firstAssert || firstAssert.pos > firstExec.pos)) {
    return `${RUN_SQLITE_SCRIPT} must call ${SAFE_ASSERT} before ${EXEC_STDIN}`;
  }
  return undefined;
}

function scanSourceFile(rel: string, content: string, offenders: string[]): void {
  const source = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(rel)
  );

  if (rel === "src/transcripts-sqlite.ts") {
    const safetyErr = runSqliteScriptHasSafetyBeforeExec(source);
    if (safetyErr) {
      offenders.push(`${rel}: ${safetyErr}`);
    }
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
      } else if (!isInsideNamedFunction(node, RUN_SQLITE_SCRIPT)) {
        offenders.push(`${rel}: ${SQLITE_SCRIPT} reference outside ${RUN_SQLITE_SCRIPT}`);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === EXEC_STDIN
    ) {
      if (rel !== "src/transcripts-sqlite.ts") {
        offenders.push(`${rel}: ${EXEC_STDIN} call outside transcripts-sqlite.ts`);
      } else {
        const inRunSqlite = isInsideNamedFunction(node, RUN_SQLITE_SCRIPT);
        const inCliSafe = isInsideRunSqliteCliSafeStdin(node);
        if (!inRunSqlite && !inCliSafe) {
          offenders.push(
            `${rel}: ${EXEC_STDIN} must be inside ${RUN_SQLITE_SCRIPT} or runSqliteCliSafeStdin`
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
