import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { collectSourceFiles, scriptKindFor } from "./sync-path-ast-guard.js";

const SQLITE_SCRIPT_IMPORT = "SQLITE_PYTHON_EXECUTESCRIPT";
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

function scanSourceFile(rel: string, content: string, offenders: string[]): void {
  const source = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(rel)
  );

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!spec.includes("sqlite-script-safety")) {
        ts.forEachChild(node, visit);
        return;
      }
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === SQLITE_SCRIPT_IMPORT && rel !== "src/transcripts-sqlite.ts") {
            offenders.push(
              `${rel}: only transcripts-sqlite.ts may import ${SQLITE_SCRIPT_IMPORT}`
            );
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (name === SQLITE_SCRIPT_IMPORT || name === "resolvePythonInterpreterForSqlite") {
          offenders.push(`${rel}: must not re-export ${name}`);
        }
      }
    }

    if (
      ts.isIdentifier(node) &&
      node.text === SQLITE_SCRIPT_IMPORT &&
      !ts.isVariableDeclaration(node.parent) &&
      !(ts.isImportSpecifier(node.parent) && ts.isIdentifier(node.parent.name))
    ) {
      if (rel === "src/sqlite-script-safety.ts") {
        // definition site
      } else if (rel !== "src/transcripts-sqlite.ts") {
        offenders.push(`${rel}: references ${SQLITE_SCRIPT_IMPORT}`);
      } else if (!isInsideNamedFunction(node, RUN_SQLITE_SCRIPT)) {
        offenders.push(
          `${rel}: ${SQLITE_SCRIPT_IMPORT} reference outside ${RUN_SQLITE_SCRIPT}`
        );
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
            `${rel}: ${EXEC_STDIN} must be inside ${RUN_SQLITE_SCRIPT} after safety checks or runSqliteCliSafeStdin`
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
