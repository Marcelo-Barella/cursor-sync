import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
// @ts-expect-error JS guard module has no types
import { assertBundleRuntimeImports } from "../esbuild-bundle-guard.mjs";
import {
  AST_ALLOWLIST,
  collectSourceFiles,
  scanFileAt,
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
      offenders.push(...scanFileAt(abs, rel.replace(/\\/g, "/")));
    }
    expect(offenders).toEqual([]);
  });

  it("rejects every Tester AST probe fixture", () => {
    const files = fs
      .readdirSync(probeDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("allowed-"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const abs = path.join(probeDir, file);
      const offenders = scanFileAt(abs, `tests/fixtures/ast-probes/${file}`);
      expect(offenders.length, `expected violations in ${file}`).toBeGreaterThan(0);
    }
  });

  it("allows safe os-runtime wrapper usage in synthetic snippet", () => {
    const offenders = scanSourceText(
      "synthetic/allowed.ts",
      `import { nodePlatform } from "./os-runtime.js"; export const p = nodePlatform();`
    );
    expect(offenders).toEqual([]);
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

    expect(() => assertBundleRuntimeImports(result.metafile)).toThrow(
      /Forbidden runtime imports/
    );
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

});
