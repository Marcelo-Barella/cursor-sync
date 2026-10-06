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

const BANNED_MODULES = new Set([
  "os",
  "node:os",
  "process",
  "node:process",
  "vm",
  "node:vm",
  "child_process",
  "node:child_process",
  "module",
  "node:module",
]);

const FORBIDDEN_IDENTIFIERS = new Set([
  "globalThis",
  "eval",
  "Function",
  "Reflect",
  "module",
  "vm",
  "process",
]);

export function scriptKindFor(rel: string): ts.ScriptKind {
  if (rel.endsWith(".mts")) return ts.ScriptKind.MTS;
  if (rel.endsWith(".cts")) return ts.ScriptKind.CTS;
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

function isBannedModule(text: string): boolean {
  return BANNED_MODULES.has(text) || BANNED_MODULES.has(`node:${text}`);
}

function note(rel: string, offenders: string[], message: string): void {
  offenders.push(`${rel}: ${message}`);
}

function isConstructorConstructorChain(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessChain(node)) {
    return false;
  }
  if (node.name.text !== "constructor") {
    return false;
  }
  const inner = node.expression;
  if (!ts.isPropertyAccessExpression(inner) && !ts.isPropertyAccessChain(inner)) {
    return false;
  }
  return inner.name.text === "constructor";
}

function isDirectRequireCall(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") {
    return false;
  }
  const arg = node.arguments[0];
  return Boolean(arg && ts.isStringLiteral(arg));
}

export function visitAst(node: ts.Node, rel: string, offenders: string[]): void {
  if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
    if (node.text === "eval") {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        note(rel, offenders, "eval()");
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "eval"
      ) {
        note(rel, offenders, "globalThis.eval");
      }
    } else if (node.text === "Function") {
      const parent = node.parent;
      if (
        (ts.isNewExpression(parent) && parent.expression === node) ||
        (ts.isCallExpression(parent) && parent.expression === node)
      ) {
        note(rel, offenders, "Function constructor");
      }
    } else if (node.text === "createRequire") {
      note(rel, offenders, "createRequire");
    } else {
      note(rel, offenders, `references identifier ${node.text}`);
    }
  }

  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "g" && node.argumentExpression) {
      const arg = node.argumentExpression;
      if (
        ts.isBinaryExpression(arg) &&
        arg.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        note(rel, offenders, "g['proc'+'ess']");
      }
    }
  }

  if (ts.isCallExpression(node)) {
    let commaExpr: ts.BinaryExpression | undefined;
    if (ts.isBinaryExpression(node.expression)) {
      commaExpr = node.expression;
    } else if (
      ts.isParenthesizedExpression(node.expression) &&
      ts.isBinaryExpression(node.expression.expression)
    ) {
      commaExpr = node.expression.expression;
    }
    if (
      commaExpr &&
      commaExpr.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      ts.isNumericLiteral(commaExpr.left) &&
      commaExpr.left.text === "0" &&
      ts.isIdentifier(commaExpr.right) &&
      commaExpr.right.text === "eval"
    ) {
      note(rel, offenders, "(0,eval)");
    }
  }

  if (isConstructorConstructorChain(node)) {
    note(rel, offenders, ".constructor.constructor");
  }

  if (ts.isTaggedTemplateExpression(node)) {
    if (ts.isIdentifier(node.tag) && node.tag.text === "child_process") {
      note(rel, offenders, "child_process template");
    }
  }

  if (ts.isCallExpression(node)) {
    const callExpr = node.expression;
    if (
      ts.isParenthesizedExpression(callExpr) &&
      ts.isIdentifier(callExpr.expression) &&
      callExpr.expression.text === "require"
    ) {
      note(rel, offenders, "(require)(...)");
    }
    if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        note(rel, offenders, "dynamic require()");
      } else if (isBannedModule(arg.text)) {
        note(rel, offenders, `require('${arg.text}')`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "require" &&
      node.expression.name.text === "call"
    ) {
      note(rel, offenders, "require.call");
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "m" &&
      node.expression.name.text === "createRequire"
    ) {
      note(rel, offenders, "aliased createRequire");
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "vm" &&
      node.expression.name.text === "runInThisContext"
    ) {
      note(rel, offenders, "vm.runInThisContext");
    }
  }

  if (ts.isElementAccessExpression(node)) {
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "require"
    ) {
      note(rel, offenders, "module['require']");
    }
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "process"
    ) {
      note(rel, offenders, "globalThis['process']");
    }
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.name.text === "eval"
    ) {
      note(rel, offenders, "globalThis.eval");
    }
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Reflect" &&
      node.name.text === "get"
    ) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        const [target, key] = parent.arguments;
        if (
          target &&
          ts.isIdentifier(target) &&
          target.text === "globalThis" &&
          key &&
          ts.isStringLiteral(key) &&
          key.text === "process"
        ) {
          note(rel, offenders, "Reflect.get(globalThis,'process')");
        }
      }
    }
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Object" &&
      node.name.text === "getOwnPropertyDescriptor"
    ) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        const [target] = parent.arguments;
        if (target && ts.isIdentifier(target) && target.text === "globalThis") {
          note(rel, offenders, "Object.getOwnPropertyDescriptor(globalThis,...)");
        }
      }
    }
  }

  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (ts.isIdentifier(node.initializer) && node.initializer.text === "require") {
      note(rel, offenders, "aliased require");
    }
  }

  if (ts.isImportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && isBannedModule(spec.text)) {
      note(rel, offenders, `imports ${spec.text}`);
    }
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && isBannedModule(spec.text)) {
      note(rel, offenders, `export-from ${spec.text}`);
    }
  }

  if (ts.isImportEqualsDeclaration(node) && node.moduleReference) {
    if (ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr) && isBannedModule(expr.text)) {
        note(rel, offenders, `import = require('${expr.text}')`);
      }
    }
  }

  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteral(arg)) {
      note(rel, offenders, "dynamic import()");
    } else if (isBannedModule(arg.text)) {
      note(rel, offenders, `dynamic import(${arg.text})`);
    }
  }

  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    const text = node.getText();
    if (text.includes("echo $HOME") && text.includes("child_process")) {
      note(rel, offenders, "child_process echo $HOME");
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
