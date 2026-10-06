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

const HOME_PATH_LITERAL_RE =
  /(^|[^a-z])\/home\/|\/Users\/|C:\\Users|~\/Library\/|~\/AppData\/|\/root\/|~\/\.cursor|~\/(?![a-z])/i;

const HOME_PATH_JOIN_FIRST_SEG = new Set(["/home", "/Users", "/root"]);

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
  if (/os\.environ\s*\[\s*['"]HOME['"]\s*\]/.test(text)) {
    return true;
  }
  if (/\/environ\b/.test(text) || /\benviron\b/.test(text)) {
    if (!/\benvironment\b/i.test(text) && (text.includes("/") || text.includes("\\"))) {
      return true;
    }
  }
  return false;
}

function stringHasParentSegment(text: string): boolean {
  return text.includes("..");
}

function stringLooksLikeHomePath(text: string): boolean {
  return HOME_PATH_LITERAL_RE.test(text);
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

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isPropertySignature(parent) && parent.name === node) {
    return true;
  }
  if (ts.isImportSpecifier(parent) && parent.propertyName === node) {
    return true;
  }
  return false;
}

function isTypePosition(node: ts.Identifier): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isTypeReferenceNode(current) ||
      ts.isTypeQueryNode(current) ||
      ts.isTypePredicateNode(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return true;
    }
    if (ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isObjectLiteralKey(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }
  if (ts.isPropertySignature(parent) && parent.name === node) {
    return true;
  }
  if (ts.isMethodSignature(parent) && parent.name === node) {
    return true;
  }
  return false;
}

function isPropertyNameInAccess(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node &&
    ts.isStringLiteral(node)
  ) {
    return true;
  }
  return false;
}

function isReflectMemberAccess(node: ts.Identifier): boolean {
  if (node.text !== "Reflect") {
    return false;
  }
  const parent = node.parent;
  return Boolean(parent && ts.isPropertyAccessExpression(parent) && parent.expression === node);
}

function isConstructorComparison(node: ts.PropertyAccessExpression): boolean {
  if (node.name.text !== "constructor") {
    return false;
  }
  const parent = node.parent;
  if (!parent || !ts.isBinaryExpression(parent)) {
    return false;
  }
  const op = parent.operatorToken.kind;
  return (
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function collectBindingNames(pattern: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(pattern)) {
    into.add(pattern.text);
    return;
  }
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) {
      continue;
    }
    if (el.propertyName && ts.isIdentifier(el.propertyName)) {
      continue;
    }
    collectBindingNames(el.name, into);
  }
}

function scanForbiddenIdentifiers(
  sourceFile: ts.SourceFile,
  rel: string,
  offenders: string[]
): void {
  const scopes: Set<string>[] = [new Set()];

  const isBound = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i]!.has(name)) {
        return true;
      }
    }
    return false;
  };

  const declareInCurrent = (name: string): void => {
    scopes[scopes.length - 1]!.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) {
      if (
        !isDeclarationName(node) &&
        !isTypePosition(node) &&
        !isObjectLiteralKey(node) &&
        !isPropertyNameInAccess(node) &&
        !(node.text === "Reflect" && isReflectMemberAccess(node)) &&
        !isBound(node.text)
      ) {
        note(rel, offenders, `forbidden identifier ${node.text}`);
      }
    }

    if (ts.isImportSpecifier(node) && ts.isIdentifier(node.name)) {
      declareInCurrent(node.name.text);
    }
    if (ts.isImportClause(node) && node.name) {
      declareInCurrent(node.name.text);
    }

    const pushScope = (): void => {
      scopes.push(new Set());
    };
    const popScope = (): void => {
      scopes.pop();
    };

    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        declareInCurrent(node.name.text);
      }
      pushScope();
      for (const param of node.parameters) {
        collectBindingNames(param.name, scopes[scopes.length - 1]!);
      }
      ts.forEachChild(node, visit);
      popScope();
      return;
    }

    if (ts.isCatchClause(node)) {
      pushScope();
      if (node.variableDeclaration) {
        collectBindingNames(node.variableDeclaration.name, scopes[scopes.length - 1]!);
      }
      ts.forEachChild(node, visit);
      popScope();
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      pushScope();
      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) {
          collectBindingNames(decl.name, scopes[scopes.length - 1]!);
        }
      }
      ts.forEachChild(node, visit);
      popScope();
      return;
    }

    if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node)) {
      pushScope();
      ts.forEachChild(node, visit);
      popScope();
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, scopes[scopes.length - 1]!);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function isDynamicImportOrRequire(node: ts.CallExpression): boolean {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return true;
  }
  return false;
}

function importArgIsStringLiteral(node: ts.CallExpression): boolean {
  const arg = node.arguments[0];
  if (!arg) {
    return false;
  }
  return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);
}

function resolveImportTarget(
  specifier: string,
  fromRel: string,
  repoRoot: string
): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return undefined;
  }
  const fromDir = path.dirname(fromRel);
  const resolved = path.normalize(path.join(fromDir, specifier));
  const abs = path.join(repoRoot, resolved);
  return abs;
}

function isImportOutsideSrc(specifier: string, fromRel: string, repoRoot: string): boolean {
  if (specifier.includes("node_modules")) {
    return false;
  }
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return false;
  }
  const abs = resolveImportTarget(specifier.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, ""), fromRel, repoRoot);
  if (!abs) {
    return false;
  }
  const srcRoot = path.join(repoRoot, "src");
  const normalized = path.normalize(abs);
  if (!normalized.startsWith(srcRoot + path.sep) && normalized !== srcRoot) {
    return true;
  }
  return false;
}

function isModuleTopLevelNode(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

export function visitAst(
  node: ts.Node,
  rel: string,
  offenders: string[],
  opts: { repoRoot: string; sourceFile: ts.SourceFile }
): void {
  const sourceFile = opts.sourceFile;

  if (
    isModuleTopLevelNode(node) &&
    ts.isIdentifier(node) &&
    node.text === "arguments" &&
    !isDeclarationName(node) &&
    !isPropertyNameInAccess(node)
  ) {
    note(rel, offenders, "forbidden top-level identifier arguments");
  }

  if (ts.isPropertyAccessExpression(node) && node.name.text === "constructor") {
    if (!isConstructorComparison(node)) {
      note(rel, offenders, "forbidden .constructor access");
    }
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "constructor"
  ) {
    note(rel, offenders, "forbidden .constructor access");
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    !ts.isStringLiteral(node.argumentExpression) &&
    !ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
  ) {
    const expr = node.expression.getText();
    if (expr.endsWith("constructor") || node.getText().includes("constructor")) {
      note(rel, offenders, "forbidden computed .constructor access");
    }
  }

  if (ts.isBindingElement(node) && node.propertyName?.getText() === "constructor") {
    note(rel, offenders, "forbidden destructured constructor");
  }

  if (ts.isStringLiteral(node)) {
    if (stringHasForbiddenPathContent(node.text)) {
      note(rel, offenders, "forbidden string literal (/proc/ or environ)");
    }
    if (!AST_ALLOWLIST.has(rel) && stringLooksLikeHomePath(node.text)) {
      note(rel, offenders, "forbidden home path string literal");
    }
  }

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (stringHasForbiddenPathContent(node.text)) {
      note(rel, offenders, "forbidden template (/proc/ or environ)");
    }
    if (!AST_ALLOWLIST.has(rel) && stringLooksLikeHomePath(node.text)) {
      note(rel, offenders, "forbidden home path template");
    }
  }

  if (ts.isTemplateExpression(node) || ts.isTemplateSpan(node)) {
    const text = node.getText();
    if (stringHasForbiddenPathContent(text)) {
      note(rel, offenders, "forbidden template (/proc/ or environ)");
    }
    if (!AST_ALLOWLIST.has(rel) && stringLooksLikeHomePath(text)) {
      note(rel, offenders, "forbidden home path template");
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
    if (ts.isStringLiteral(spec)) {
      if (isBannedImportModule(spec.text)) {
        note(rel, offenders, `forbidden import ${spec.text}`);
      }
      if (rel.startsWith("src/") && isImportOutsideSrc(spec.text, rel, opts.repoRoot)) {
        note(rel, offenders, `import resolves outside src/: ${spec.text}`);
      }
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

  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === "path" &&
    node.expression.name.text === "join"
  ) {
    const first = node.arguments[0];
    if (ts.isStringLiteral(first) && HOME_PATH_JOIN_FIRST_SEG.has(first.text)) {
      note(rel, offenders, "forbidden path.join home segment");
    }
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && rel.startsWith("src/")) {
      if (isImportOutsideSrc(spec.text, rel, opts.repoRoot)) {
        note(rel, offenders, `export-from resolves outside src/: ${spec.text}`);
      }
    }
  }

  if (ts.isCallExpression(node) && isDynamicImportOrRequire(node)) {
    const arg = node.arguments[0];
    if (!importArgIsStringLiteral(node)) {
      note(rel, offenders, "forbidden dynamic import/require without string literal");
    } else if (ts.isStringLiteral(arg) && isBannedImportModule(arg.text)) {
      note(rel, offenders, `forbidden dynamic import(${arg.text})`);
    }
  }

  ts.forEachChild(node, (child) => visitAst(child, rel, offenders, opts));
}

export function scanMetafileInputs(
  metafile: { inputs?: Record<string, unknown> },
  repoRoot: string
): string[] {
  const offenders: string[] = [];
  for (const inputPath of bundleInputPathsFromMetafile(metafile)) {
    const normalized = inputPath.replace(/\\/g, "/");
    if (normalized.includes("node_modules")) {
      continue;
    }
    if (!normalized.startsWith("src/")) {
      continue;
    }
    if (AST_ALLOWLIST.has(normalized)) {
      continue;
    }
    const abs = path.join(repoRoot, normalized);
    if (!fs.existsSync(abs)) {
      continue;
    }
    offenders.push(...scanFileAt(abs, normalized, repoRoot));
  }
  return offenders;
}

export function scanSourceText(
  rel: string,
  content: string,
  repoRoot?: string
): string[] {
  const offenders: string[] = [];
  const kind = scriptKindFor(rel);
  const source = ts.createSourceFile(
    rel,
    content,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const root = repoRoot ?? process.cwd();
  scanForbiddenIdentifiers(source, rel, offenders);
  visitAst(source, rel, offenders, {
    repoRoot: root,
    sourceFile: source,
  });
  return offenders;
}

export function scanFileAt(relPath: string, relLabel: string, repoRoot?: string): string[] {
  const content = fs.readFileSync(relPath, "utf-8");
  return scanSourceText(relLabel, content, repoRoot ?? path.dirname(path.dirname(relPath)));
}

export function bundleInputPathsFromMetafile(metafile: {
  inputs?: Record<string, unknown>;
}): string[] {
  return Object.keys(metafile.inputs ?? {}).map((p) => p.replace(/\\/g, "/"));
}
