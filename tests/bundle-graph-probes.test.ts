import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error JS guard module
import { assertBundleRuntimeImports } from "../esbuild-bundle-guard.mjs";

const repoRoot = process.cwd();
const probesRoot = path.join(repoRoot, "tests", "fixtures", "bundle-graph-probes");
const tmpDirs: string[] = [];

async function buildProbe(
  entry: string,
  options?: { tsconfig?: string; absWorkingDir?: string; plugins?: esbuild.Plugin[] }
): Promise<esbuild.BuildResult> {
  const out = path.join(os.tmpdir(), `cursor-sync-bundle-probe-${Date.now()}-${Math.random()}`);
  tmpDirs.push(out);
  return esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile: path.join(out, "out.js"),
    platform: "node",
    format: "cjs",
    write: true,
    metafile: true,
    logLevel: "silent",
    tsconfig: options?.tsconfig,
    absWorkingDir: options?.absWorkingDir,
    plugins: options?.plugins,
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundle graph probes (g04-g08, g11, nml)", () => {
  it("g07: export-from outside src fails bundle input guard", async () => {
    const entry = path.join(probesRoot, "g07-export-from", "entry.ts");
    const result = await buildProbe(entry);
    expect(() => assertBundleRuntimeImports(result.metafile, repoRoot)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("g08: dynamic import outside src fails bundle input guard", async () => {
    const entry = path.join(probesRoot, "g08-dynamic-import", "entry.ts");
    const result = await buildProbe(entry);
    expect(() => assertBundleRuntimeImports(result.metafile, repoRoot)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("g11: import=require outside src fails bundle input guard", async () => {
    const entry = path.join(probesRoot, "g11-import-equals", "entry.ts");
    const result = await buildProbe(entry);
    expect(() => assertBundleRuntimeImports(result.metafile, repoRoot)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("g05: tsconfig paths alias outside src fails bundle input guard", async () => {
    const dir = path.join(probesRoot, "g05-tsconfig-paths");
    const outsideHome = path.join(repoRoot, "tests", "fixtures", "qa23-outside", "home.ts");
    const result = await buildProbe(path.join(dir, "entry.ts"), {
      tsconfig: path.join(dir, "tsconfig.json"),
      absWorkingDir: dir,
      plugins: [
        {
          name: "g05-tsconfig-paths",
          setup(build) {
            build.onResolve({ filter: /^@qa-outside\// }, (args) => ({
              path: path.join(
                path.dirname(outsideHome),
                args.path.replace(/^@qa-outside\//, "") + ".ts"
              ),
            }));
          },
        },
      ],
    });
    expect(() => assertBundleRuntimeImports(result.metafile, dir)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("g06: package.json imports alias outside src fails bundle input guard", async () => {
    const dir = path.join(probesRoot, "g06-package-imports");
    const entry = path.join(dir, "entry.ts");
    const outsideHome = path.join(repoRoot, "tests", "fixtures", "qa23-outside", "home.ts");
    const result = await buildProbe(entry, {
      absWorkingDir: dir,
      plugins: [
        {
          name: "g06-package-imports",
          setup(build) {
            build.onResolve({ filter: /^#outside$/ }, () => ({ path: outsideHome }));
          },
        },
      ],
    });
    expect(() => assertBundleRuntimeImports(result.metafile, dir)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("g04: directory symlink into src still fails when realpath is outside src", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-sync-g04-"));
    tmpDirs.push(work);
    const srcDir = path.join(work, "src");
    const outsideDir = path.join(work, "outside");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, "leak.ts"),
      `export const leakedHome = process.env.HOME ?? "";`,
      "utf8"
    );
    fs.symlinkSync(outsideDir, path.join(srcDir, "linked"), "dir");
    const entry = path.join(srcDir, "linked", "leak.ts");
    const result = await buildProbe(entry);
    expect(() => assertBundleRuntimeImports(result.metafile, repoRoot)).toThrow(
      /outside.*src|allowed node_modules/i
    );
  });

  it("nml: symlinked undeclared package under node_modules fails guard", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-sync-nml-"));
    tmpDirs.push(work);
    const nm = path.join(work, "node_modules");
    const outsidePkg = path.join(work, "outside-pkg");
    fs.mkdirSync(nm, { recursive: true });
    fs.mkdirSync(outsidePkg, { recursive: true });
    fs.writeFileSync(
      path.join(outsidePkg, "index.js"),
      `module.exports = { home: process.env.HOME };`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(outsidePkg, "package.json"),
      JSON.stringify({ name: "evil-outside-pkg", main: "index.js" }),
      "utf8"
    );
    fs.symlinkSync(outsidePkg, path.join(nm, "evil-outside-pkg"), "dir");
    const entry = path.join(work, "entry.ts");
    fs.writeFileSync(
      entry,
      `import x from "evil-outside-pkg";\nexport const v = x;\n`,
      "utf8"
    );
    const result = await buildProbe(entry, { absWorkingDir: work });
    expect(() => assertBundleRuntimeImports(result.metafile, work)).toThrow(
      /not a declared runtime dependency|outside|symlink/i
    );
  });

  it("nml3: symlinked declared dependency escaping repo fails guard", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-sync-nml3-"));
    tmpDirs.push(work);
    const nm = path.join(work, "node_modules");
    const outsidePkg = path.join(work, "outside-minimatch");
    fs.mkdirSync(nm, { recursive: true });
    fs.mkdirSync(outsidePkg, { recursive: true });
    fs.writeFileSync(path.join(outsidePkg, "index.js"), `module.exports = {};`, "utf8");
    fs.writeFileSync(
      path.join(outsidePkg, "package.json"),
      JSON.stringify({ name: "minimatch", main: "index.js" }),
      "utf8"
    );
    fs.symlinkSync(outsidePkg, path.join(nm, "minimatch"), "dir");
    fs.writeFileSync(
      path.join(work, "package.json"),
      JSON.stringify({ name: "probe", dependencies: { minimatch: "10.0.0" } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(work, "entry.ts"),
      `import mm from "minimatch";\nexport const v = mm;\n`,
      "utf8"
    );
    const result = await buildProbe(path.join(work, "entry.ts"), { absWorkingDir: work });
    expect(() => assertBundleRuntimeImports(result.metafile, work)).toThrow(
      /symlink|outside|node_modules/i
    );
  });
});
