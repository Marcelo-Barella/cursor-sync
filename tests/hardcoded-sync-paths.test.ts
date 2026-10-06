import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
// @ts-expect-error JS guard module has no types
import { assertBundleRuntimeImports } from "../esbuild-bundle-guard.mjs";
import {
  AST_ALLOWLIST,
  bundleInputPathsFromMetafile,
  collectSourceFiles,
  scanFileAt,
  scanMetafileInputs,
  scanSourceText,
} from "./sync-path-ast-guard.js";

const repoRoot = process.cwd();
const probeDir = path.join(repoRoot, "tests", "fixtures", "ast-probes");

describe("sync path hardcoding guard (AST)", () => {
  it("forbids banned identifiers and imports in every src file outside allowlist", () => {
    const srcDir = path.join(repoRoot, "src");
    const offenders: string[] = [];
    for (const rel of collectSourceFiles(srcDir)) {
      if (AST_ALLOWLIST.has(rel)) {
        continue;
      }
      const abs = path.join(repoRoot, rel);
      offenders.push(...scanFileAt(abs, rel.replace(/\\/g, "/"), repoRoot));
    }
    expect(offenders).toEqual([]);
  });

  it("rejects every Tester AST probe fixture", () => {
    const skipAsSrcOnly = new Set(["f05.ts", "g04-reexport.ts", "m14.ts"]);
    const files = fs
      .readdirSync(probeDir)
      .filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.startsWith("allowed-") &&
          !skipAsSrcOnly.has(f)
      );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const abs = path.join(probeDir, file);
      const offenders = scanFileAt(
        abs,
        `tests/fixtures/ast-probes/${file}`,
        repoRoot
      );
      expect(offenders.length, `expected violations in ${file}`).toBeGreaterThan(0);
    }
  });

  it("rejects f05 import outside src when scanned as src module", () => {
    const content = fs.readFileSync(path.join(probeDir, "f05.ts"), "utf8");
    const offenders = scanSourceText("src/_f05.ts", content, repoRoot);
    expect(offenders.some((o) => o.includes("outside src"))).toBe(true);
  });

  it("rejects g04 export-from outside src when scanned as src module", () => {
    const content = fs.readFileSync(path.join(probeDir, "g04-reexport.ts"), "utf8");
    const offenders = scanSourceText("src/_g04.ts", content, repoRoot);
    expect(offenders.some((o) => o.includes("export-from") || o.includes("outside src"))).toBe(
      true
    );
  });

  it("allows false-positive-safe AST patterns in allowed fixtures", () => {
    const allowed = fs
      .readdirSync(probeDir)
      .filter((f) => f.startsWith("allowed-") && f.endsWith(".ts"));
    for (const file of allowed) {
      const abs = path.join(probeDir, file);
      const offenders = scanFileAt(
        abs,
        `tests/fixtures/ast-probes/${file}`,
        repoRoot
      );
      expect(offenders, file).toEqual([]);
    }
  });

  it("allows safe os-runtime wrapper usage in synthetic snippet", () => {
    const offenders = scanSourceText(
      "synthetic/allowed.ts",
      `import { nodePlatform } from "./os-runtime.js"; export const p = nodePlatform();`,
      repoRoot
    );
    expect(offenders).toEqual([]);
  });

  it("scans bundled metafile inputs the same as src tree", async () => {
    const metaPath = path.join(repoRoot, "dist", "extension.meta.json");
    if (!fs.existsSync(metaPath)) {
      await esbuild.build({
        entryPoints: [path.join(repoRoot, "src", "extension.ts")],
        bundle: true,
        outfile: path.join(repoRoot, "dist", "extension.js"),
        external: ["vscode"],
        platform: "node",
        format: "cjs",
        metafile: true,
        logLevel: "silent",
      });
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      inputs?: Record<string, unknown>;
    };
    const inputs = bundleInputPathsFromMetafile(meta).filter(
      (p) => p.startsWith("src/") && !p.includes("node_modules")
    );
    expect(inputs.length).toBeGreaterThan(0);
    expect(scanMetafileInputs(meta, repoRoot)).toEqual([]);
  });
});

describe("bundle runtime import guard", () => {
  it("fails build when a non-allowlisted file imports node:process", async () => {
    const fixtureDir = path.join(repoRoot, "tests", "fixtures", "bundle-forbidden-import");
    const entry = path.join(fixtureDir, "entry.ts");
    const bad = path.join(fixtureDir, "bad.ts");
    const outFile = path.join(fixtureDir, "out.js");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      bad,
      `import process from "node:process";\nexport const pid = process.pid;\n`,
      "utf8"
    );
    fs.writeFileSync(entry, `import "./bad.js";\nexport {};\n`, "utf8");

    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: outFile,
      platform: "node",
      format: "cjs",
      write: true,
      metafile: true,
      logLevel: "silent",
    });

    expect(() => assertBundleRuntimeImports(result.metafile, repoRoot)).toThrow(
      /Forbidden runtime imports|outside.*src|allowed node_modules/i
    );
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
});
