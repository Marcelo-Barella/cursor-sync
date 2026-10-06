import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWLIST = new Set([
  path.join("src", "paths.ts"),
  path.join("src", "os-runtime.ts"),
]);

describe("sync path hardcoding guard (AST)", () => {
  it("only paths.ts and os-runtime.ts may touch process.env, process destructuring, os, or dynamic require", () => {
    const srcDir = path.join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const rel of collectSourceFiles(srcDir)) {
      if (ALLOWLIST.has(rel)) {
        continue;
      }
      const filePath = path.join(process.cwd(), rel);
      const content = fs.readFileSync(filePath, "utf-8");
      const source = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        rel.endsWith(".mts") ? ts.ScriptKind.MTS : ts.ScriptKind.TS
      );
      visit(source, rel, offenders);
    }

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(dir: string, base = "src"): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
      files.push(rel);
    }
  }
  return files;
}

function visit(node: ts.Node, rel: string, offenders: string[]): void {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isPropertyAccessChain(node)
  ) {
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      offenders.push(`${rel}: process.env access`);
    }
  }
  if (ts.isElementAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "process") {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        offenders.push(`${rel}: process[env] access`);
      }
    }
  }
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (
      ts.isObjectBindingPattern(node.name) &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "process"
    ) {
      offenders.push(`${rel}: destructuring process`);
    }
  }
  if (ts.isImportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && isOsModule(spec.text)) {
      offenders.push(`${rel}: imports os`);
    }
  }
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        offenders.push(`${rel}: dynamic require()`);
      } else if (isOsModule(arg.text)) {
        offenders.push(`${rel}: require('os')`);
      }
    }
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        offenders.push(`${rel}: dynamic import()`);
      } else if (isOsModule(arg.text)) {
        offenders.push(`${rel}: dynamic import('os')`);
      }
    }
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression) &&
    isOsModule(node.moduleReference.expression.text)
  ) {
    offenders.push(`${rel}: import os via import=`);
  }
  if (ts.isIdentifier(node) && node.text === "createRequire") {
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      offenders.push(`${rel}: createRequire`);
    }
  }
  ts.forEachChild(node, (child) => visit(child, rel, offenders));
}

function isOsModule(text: string): boolean {
  return text === "os" || text === "node:os";
}
