import * as esbuild from "esbuild";
import * as fs from "node:fs";
import { assertBundleRuntimeImports } from "./esbuild-bundle-guard.mjs";

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
  metafile: true,
  plugins: [
    {
      name: "bundle-runtime-guard",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors?.length) {
            return;
          }
          if (!result.metafile) {
            return;
          }
          await fs.promises.writeFile(
            "dist/extension.meta.json",
            JSON.stringify(result.metafile, null, 2),
            "utf8"
          );
          assertBundleRuntimeImports(result.metafile);
        });
      },
    },
  ],
};

const ctx = await esbuild.context(buildOptions);

if (watch) {
  await ctx.watch();
  console.log("Watching...");
} else {
  const result = await ctx.rebuild();
  if (result.errors?.length) {
    await ctx.dispose();
    process.exit(1);
  }
  await ctx.dispose();
  console.log("Build complete.");
}
