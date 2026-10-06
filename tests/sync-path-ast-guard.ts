import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export const AST_ALLOWLIST = new Set([
  path.join("src", "paths.ts"),
  path.join("src", "os-runtime.ts"),
]);

export const SOURCE_EXTS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".js",
  ".mjs",
  ".cjs",
];

const FORBIDDEN_IDENTIFIERS = new Set([
  "require",
  "module",
  "process",
  "global",
  "globalThis",
  "eval",
  "Function",
  "Reflect",
]);

const BANNED_IMPORT_MODULES = new Set([
  "os",
  "node:os",
  "process",
  "node:process",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "inspector",
  "node:inspector",
  "vm",
  "node:vm",
  "module",
  "node:module",
  "v8",
  "node:v8",
  "cluster",
  "node:cluster",
]);

const PATH_HELPER_IDENTIFIERS = new Set(["systemTmpDir"]);

function normalizeModuleSpecifier(text: string): string {
  return text.replace(/^node:/, "");
}

function isBannedImportModule(text: string): boolean {
  return (
    BANNED_IMPORT_MODULES.has(text) ||
    BANNED_IMPORT_MODULES.has(`node:${normalizeModuleSpecifier(text)}`)
  );
}

function note(rel: string, offenders: string[], message: string): void {
  offenders.push(`${rel}: ${message}`);
}

export function scriptKindFor(rel: string): ts.ScriptKind {
  if (rel.endsWith(".mts")) return ts.ScriptKind.TS;
  if (rel.endsWith(".cts")) return ts.ScriptKind.TS;
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (rel.endsWith(".js") || rel.endsWith(".mjs")) return ts.ScriptKind.JS;
  if (rel.endsWith(".cjs")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

export function collectSourceFiles(dir: string, base = "src"): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.join(dir, entry.name), rel));
    } else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      files.push(rel);
    }
  }
  return files;
}

function stringHasForbiddenPathContent(text: string): boolean {
  if (text.includes("/proc/")) {
    return true;
  }
  if (text.includes("/environ")) {
    return true;
  }
  if (text.includes("environ")) {
    const withoutEnvironmentWord = text.replace(/environment/gi, "");
    if (withoutEnvironmentWord.includes("environ")) {
      return true;
    }
  }
  return false;
}

function stringHasParentSegment(text: string): boolean {
  return text.includes("..");
}

function subtreeContainsSystemTmpDir(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      PATH_HELPER_IDENTIFIERS.has(n.expression.text)
    ) {
      found = true;
      return;
    }
    if (ts.isIdentifier(n) && PATH_HELPER_IDENTIFIERS.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

function subtreeContainsParentSegmentLiteral(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isStringLiteral(n) && stringHasParentSegment(n.text)) {
      found = true;
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(n) && stringHasParentSegment(n.text)) {
      found = true;
      return;
    }
    if (ts.isTemplateExpression(n)) {
      if (stringHasParentSegment(n.getText())) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function visitAst(node: ts.Node, rel: string, offenders: string[]): void {
  if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
    note(rel, offenders, `forbidden identifier ${node.text}`);
  }

  if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") {
    note(rel, offenders, "forbidden .constructor access");
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "constructor"
  ) {
    note(rel, offenders, "forbidden .constructor access");
  }

  if (ts.isStringLiteral(node)) {
    if (stringHasForbiddenPathContent(node.text)) {
      note(rel, offenders, "forbidden string literal (/proc/ or environ)");
    }
  }

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (stringHasForbiddenPathContent(node.text)) {
      note(rel, offenders, "forbidden template (/proc/ or environ)");
    }
  }

  if (ts.isTemplateExpression(node) || ts.isTemplateSpan(node)) {
    const text = node.getText();
    if (stringHasForbiddenPathContent(text)) {
      note(rel, offenders, "forbidden template (/proc/ or environ)");
    }
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    if (
      subtreeContainsSystemTmpDir(node) &&
      subtreeContainsParentSegmentLiteral(node)
    ) {
      note(rel, offenders, "forbidden path traversal via systemTmpDir");
    }
  }

  if (ts.isImportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && isBannedImportModule(spec.text)) {
      note(rel, offenders, `forbidden import ${spec.text}`);
    }
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && isBannedImportModule(spec.text)) {
      note(rel, offenders, `forbidden export-from ${spec.text}`);
    }
  }

  if (ts.isImportEqualsDeclaration(node) && node.moduleReference) {
    if (ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr) && isBannedImportModule(expr.text)) {
        note(rel, offenders, `forbidden import = require('${expr.text}')`);
      }
    }
  }

  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (ts.isStringLiteral(arg) && isBannedImportModule(arg.text)) {
      note(rel, offenders, `forbidden dynamic import(${arg.text})`);
    }
  }

  ts.forEachChild(node, (child) => visitAst(child, rel, offenders));
}

export function scanSourceText(rel: string, content: string): string[] {
  const offenders: string[] = [];
  const kind = scriptKindFor(rel);
  const source = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  visitAst(source, rel, offenders);
  return offenders;
}

export function scanFileAt(relPath: string, relLabel: string): string[] {
  const content = fs.readFileSync(relPath, "utf-8");
  return scanSourceText(relLabel, content);
}

export function bundleInputPathsFromMetafile(metafile: {
  inputs?: Record<string, unknown>;
}): string[] {
  return Object.keys(metafile.inputs ?? {}).map((p) => p.replace(/\\/g, "/"));
}
