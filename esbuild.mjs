import * as esbuild from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
};

const ALLOWLIST = new Set(["src/paths.ts", "src/os-runtime.ts"]);
const FORBIDDEN = new Set(["os", "node:os", "process", "node:process"]);

function assertBundleRuntimeImports(metafile) {
  const offenders = [];
  for (const [inputPath, input] of Object.entries(metafile.inputs ?? {})) {
    const normalized = inputPath.replace(/\\/g, "/");
    if (!normalized.startsWith("src/") || ALLOWLIST.has(normalized)) {
      continue;
    }
    for (const imp of Object.keys(input.imports ?? {})) {
      const bare = imp.replace(/^node:/, "");
      if (FORBIDDEN.has(imp) || FORBIDDEN.has(bare)) {
        offenders.push(`${normalized} imports ${imp}`);
      }
    }
  }
  if (offenders.length > 0) {
    console.error("Forbidden runtime imports in bundle graph:\n" + offenders.join("\n"));
    process.exit(1);
  }
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching...");
} else {
  const result = await esbuild.build({ ...buildOptions, metafile: true });
  await fs.promises.writeFile(
    "dist/extension.meta.json",
    JSON.stringify(result.metafile, null, 2),
    "utf8"
  );
  assertBundleRuntimeImports(result.metafile);
  console.log("Build complete.");
}
