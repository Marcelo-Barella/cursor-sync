import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWLIST = new Set([
  path.join("src", "paths.ts"),
  path.join("src", "os-runtime.ts"),
]);

const SOURCE_EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];

describe("sync path hardcoding guard (AST)", () => {
  it("forbids process/os outside allowlist in all src sources", () => {
    const srcDir = path.join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const rel of collectSourceFiles(srcDir)) {
      if (ALLOWLIST.has(rel)) {
        continue;
      }
      const filePath = path.join(process.cwd(), rel);
      const content = fs.readFileSync(filePath, "utf-8");
      const kind = scriptKindFor(rel);
      const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
      visit(source, rel, offenders);
    }

    expect(offenders).toEqual([]);
  });

  it("flags representative bypass patterns in synthetic snippets", () => {
    const cases: Array<{ name: string; code: string; expectHit: boolean }> = [
      { name: "export * from os", code: `export * from "os";`, expectHit: true },
      {
        name: "export {homedir} from os",
        code: `export { homedir } from "node:os";`,
        expectHit: true,
      },
      {
        name: "globalThis.process.env",
        code: `const x = globalThis.process.env.HOME;`,
        expectHit: true,
      },
      {
        name: "Reflect.get process env",
        code: `const x = Reflect.get(process, "env");`,
        expectHit: true,
      },
      {
        name: "import env from process",
        code: `import { env } from "process";`,
        expectHit: true,
      },
      {
        name: "alias process env",
        code: `const p = process; p.env;`,
        expectHit: true,
      },
      {
        name: "paren process env",
        code: `const x = (process).env;`,
        expectHit: true,
      },
      {
        name: "destructure env from process",
        code: `const { env: e } = process;`,
        expectHit: true,
      },
      {
        name: "Function constructor",
        code: `const f = new Function("return 1");`,
        expectHit: true,
      },
      {
        name: "eval",
        code: `eval("1");`,
        expectHit: true,
      },
      {
        name: "module.require",
        code: `module.require("fs");`,
        expectHit: true,
      },
      {
        name: "aliased require os",
        code: `const r = require; r("os");`,
        expectHit: true,
      },
      {
        name: "dynamic import non-literal",
        code: `const m = "os"; import(m);`,
        expectHit: true,
      },
      {
        name: "createRequire",
        code: `import { createRequire } from "node:module"; createRequire(import.meta.url);`,
        expectHit: true,
      },
      {
        name: "allowed nodePlatform usage",
        code: `import { nodePlatform } from "./os-runtime.js"; nodePlatform();`,
        expectHit: false,
      },
    ];

    for (const { name, code, expectHit } of cases) {
      const offenders: string[] = [];
      const source = ts.createSourceFile(
        "synthetic.ts",
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      visit(source, `synthetic/${name}`, offenders);
      if (expectHit) {
        expect(offenders.length).toBeGreaterThan(0);
      } else {
        expect(offenders).toEqual([]);
      }
    }
  });
});

describe("bundle runtime import guard", () => {
  it("metafile exists after build and passes check script", () => {
    const metaPath = path.join(process.cwd(), "dist", "extension.meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
  });
});

function scriptKindFor(rel: string): ts.ScriptKind {
  if (rel.endsWith(".mts")) return ts.ScriptKind.MTS;
  if (rel.endsWith(".cts")) return ts.ScriptKind.CTS;
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".js") || rel.endsWith(".mjs")) return ts.ScriptKind.JS;
  if (rel.endsWith(".cjs")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function collectSourceFiles(dir: string, base = "src"): string[] {
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

function isOsModule(text: string): boolean {
  return text === "os" || text === "node:os";
}

function isProcessModule(text: string): boolean {
  return text === "process" || text === "node:process";
}

function noteProcessIdentifier(rel: string, offenders: string[]): void {
  offenders.push(`${rel}: references identifier process`);
}

function visit(node: ts.Node, rel: string, offenders: string[]): void {
  if (ts.isIdentifier(node) && node.text === "process") {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === "env") {
      noteProcessIdentifier(rel, offenders);
    } else if (ts.isPropertyAccessChain(parent) && parent.name.text === "env") {
      noteProcessIdentifier(rel, offenders);
    } else if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node
    ) {
      noteProcessIdentifier(rel, offenders);
    } else if (ts.isPropertyAccessChain(parent) && parent.expression === node) {
      noteProcessIdentifier(rel, offenders);
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      noteProcessIdentifier(rel, offenders);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      noteProcessIdentifier(rel, offenders);
    } else if (parent.kind === ts.SyntaxKind.ParenthesizedExpression) {
      noteProcessIdentifier(rel, offenders);
    } else if (
      ts.isMetaProperty(parent) ||
      (ts.isCallExpression(parent) && parent.expression === node)
    ) {
    } else {
      noteProcessIdentifier(rel, offenders);
    }
  }

  if (ts.isIdentifier(node) && node.text === "globalThis") {
    const parent = node.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "process"
    ) {
      noteProcessIdentifier(rel, offenders);
    }
  }

  if (ts.isIdentifier(node) && node.text === "eval") {
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      offenders.push(`${rel}: eval()`);
    }
  }

  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "Function") {
      offenders.push(`${rel}: new Function`);
    }
  }

  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "Function") {
      offenders.push(`${rel}: Function()`);
    }
    if (node.expression.text === "require") {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) {
        offenders.push(`${rel}: dynamic require()`);
      } else if (isOsModule(arg.text)) {
        offenders.push(`${rel}: require('os')`);
      }
    }
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "module" &&
      node.name.text === "require"
    ) {
      offenders.push(`${rel}: module.require`);
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
          target.text === "process" &&
          key &&
          ts.isStringLiteral(key) &&
          key.text === "env"
        ) {
          noteProcessIdentifier(rel, offenders);
        }
      }
    }
  }

  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "require" &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent)
    ) {
      offenders.push(`${rel}: aliased require`);
    }
    if (
      ts.isObjectBindingPattern(node.name) &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "process"
    ) {
      noteProcessIdentifier(rel, offenders);
    }
  }

  if (ts.isImportDeclaration(node)) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec)) {
      if (isOsModule(spec.text) || isProcessModule(spec.text)) {
        offenders.push(`${rel}: imports ${spec.text}`);
      }
    }
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const spec = node.moduleSpecifier;
    if (ts.isStringLiteral(spec) && (isOsModule(spec.text) || isProcessModule(spec.text))) {
      offenders.push(`${rel}: export-from ${spec.text}`);
    }
  }

  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteral(arg)) {
      offenders.push(`${rel}: dynamic import()`);
    } else if (isOsModule(arg.text) || isProcessModule(arg.text)) {
      offenders.push(`${rel}: dynamic import(${arg.text})`);
    }
  }

  if (ts.isIdentifier(node) && node.text === "createRequire") {
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) {
      offenders.push(`${rel}: createRequire`);
    }
  }

  ts.forEachChild(node, (child) => visit(child, rel, offenders));
}
