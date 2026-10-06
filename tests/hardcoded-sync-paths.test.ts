import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { assertBundleRuntimeImports } from "../esbuild-bundle-guard.mjs";
import {
  AST_ALLOWLIST,
  bundleInputPathsFromMetafile,
  scanFileAt,
  scanSourceText,
  SOURCE_EXTS,
} from "./sync-path-ast-guard.js";

const repoRoot = process.cwd();

describe("sync path hardcoding guard (AST)", () => {
  it("forbids runtime bypass patterns outside allowlist in bundle graph sources", () => {
    const metaPath = path.join(repoRoot, "dist", "extension.meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const metafile = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      inputs?: Record<string, unknown>;
    };
    const bundlePaths = bundleInputPathsFromMetafile(metafile);
    const offenders: string[] = [];

    for (const normalized of bundlePaths) {
      if (normalized.includes("node_modules/")) {
        continue;
      }
      if (!normalized.startsWith("src/")) {
        continue;
      }
      if (!SOURCE_EXTS.some((ext) => normalized.endsWith(ext))) {
        continue;
      }
      const rel = normalized.startsWith("src/")
        ? normalized
        : path.relative(repoRoot, path.resolve(repoRoot, normalized));
      if (AST_ALLOWLIST.has(rel.replace(/\\/g, "/"))) {
        continue;
      }
      const abs = path.isAbsolute(normalized)
        ? normalized
        : path.join(repoRoot, normalized);
      if (!fs.existsSync(abs)) {
        continue;
      }
      offenders.push(...scanFileAt(abs, rel.replace(/\\/g, "/")));
    }

    expect(offenders).toEqual([]);
  });

  it("flags representative bypass patterns in synthetic snippets (Tester probes)", () => {
    const cases: Array<{ name: string; code: string; expectHit: boolean }> = [
      { name: "require-process", code: `const _p = require("process");`, expectHit: true },
      {
        name: "globalThis-process",
        code: `const x = globalThis["process"];`,
        expectHit: true,
      },
      {
        name: "reflect-get",
        code: `Reflect.get(globalThis, "process");`,
        expectHit: true,
      },
      {
        name: "concat-process",
        code: `const g = globalThis; g["proc" + "ess"];`,
        expectHit: true,
      },
      {
        name: "getOwnPropertyDescriptor",
        code: `Object.getOwnPropertyDescriptor(globalThis, "process");`,
        expectHit: true,
      },
      { name: "comma-eval", code: `(0, eval)("1");`, expectHit: true },
      {
        name: "globalThis-eval",
        code: `globalThis.eval("1");`,
        expectHit: true,
      },
      {
        name: "constructor-chain",
        code: `const f = [].constructor.constructor;`,
        expectHit: true,
      },
      {
        name: "import-equals-os",
        code: `import os = require("os");`,
        expectHit: true,
      },
      { name: "paren-require", code: `(require)("os");`, expectHit: true },
      { name: "require-call", code: `require.call(null, "os");`, expectHit: true },
      {
        name: "module-require",
        code: `module["require"]("fs");`,
        expectHit: true,
      },
      {
        name: "createRequire",
        code: `import { createRequire } from "node:module"; const cr = createRequire; cr(".");`,
        expectHit: true,
      },
      {
        name: "aliased-createRequire",
        code: `const m = { createRequire: () => {} }; m.createRequire();`,
        expectHit: true,
      },
      {
        name: "vm-run",
        code: `import vm from "node:vm"; vm.runInThisContext("1");`,
        expectHit: true,
      },
      {
        name: "child-process-echo",
        code: "import child_process from 'node:child_process'; child_process`echo $HOME`;",
        expectHit: true,
      },
      {
        name: "jsx-process",
        code: `export const x = process.env;`,
        expectHit: true,
      },
      {
        name: "allowed-nodePlatform",
        code: `import { nodePlatform } from "./os-runtime.js"; nodePlatform();`,
        expectHit: false,
      },
    ];

    for (const { name, code, expectHit } of cases) {
      const ext = name === "jsx-importee" ? ".jsx" : ".ts";
      const offenders = scanSourceText(`synthetic/${name}${ext}`, code);
      if (expectHit) {
        expect(offenders.length, `expected AST hit for ${name}`).toBeGreaterThan(0);
      } else {
        expect(offenders).toEqual([]);
      }
    }
  });

  it("scans a file outside src when present in bundle graph", () => {
    const outsideDir = path.join(repoRoot, "tests", "fixtures", "ast-outside-src");
    const outsideFile = path.join(outsideDir, "runtime-probe.ts");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, `const x = globalThis.process;\n`, "utf8");
    const offenders = scanFileAt(outsideFile, "tests/fixtures/ast-outside-src/runtime-probe.ts");
    expect(offenders.length).toBeGreaterThan(0);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("bundle runtime import guard", () => {
  it("fails build when a non-allowlisted file imports node:process", async () => {
    const fixtureDir = path.join(repoRoot, "tests", "fixtures", "bundle-forbidden-import");
    const entry = path.join(fixtureDir, "entry.ts");
    const bad = path.join(fixtureDir, "bad.ts");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(bad, `import process from "node:process";\nexport const pid = process.pid;\n`, "utf8");
    fs.writeFileSync(entry, `import "./bad.js";\nexport {};\n`, "utf8");

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: path.join(fixtureDir, "out.js"),
      platform: "node",
      format: "cjs",
      write: true,
      metafile: true,
      logLevel: "silent",
    });

    expect(() => assertBundleRuntimeImports(result.metafile)).toThrow(
      /Forbidden runtime imports/
    );
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
});
