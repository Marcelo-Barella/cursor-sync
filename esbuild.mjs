import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertBundleRuntimeImports } from "./esbuild-bundle-guard.mjs";

const watch = process.argv.includes("--watch");
const finalOut = "dist/extension.js";
const tempOut = "dist/extension.js.tmp";
const metaPath = "dist/extension.meta.json";

async function removeIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: tempOut,
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
            await removeIfExists(tempOut);
            await removeIfExists(`${tempOut}.map`);
            return;
          }
          if (!result.metafile) {
            return;
          }
          try {
            assertBundleRuntimeImports(result.metafile);
            await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
            await fs.promises.writeFile(
              metaPath,
              JSON.stringify(result.metafile, null, 2),
              "utf8"
            );
            await removeIfExists(finalOut);
            await removeIfExists(`${finalOut}.map`);
            await fs.promises.rename(tempOut, finalOut);
            const tempMap = `${tempOut}.map`;
            const finalMap = `${finalOut}.map`;
            try {
              await fs.promises.access(tempMap);
              await fs.promises.rename(tempMap, finalMap);
            } catch {
              /* no sourcemap */
            }
          } catch (err) {
            await removeIfExists(tempOut);
            await removeIfExists(`${tempOut}.map`);
            await removeIfExists(finalOut);
            await removeIfExists(`${finalOut}.map`);
            await removeIfExists(metaPath);
            console.error(err instanceof Error ? err.message : String(err));
            if (!watch) {
              process.exit(1);
            }
          }
        });
      },
    },
  ],
};

const ctx = await esbuild.context(buildOptions);

try {
  if (watch) {
    await ctx.watch();
    console.log("Watching...");
  } else {
    const result = await ctx.rebuild();
    if (result.errors?.length) {
      process.exit(1);
    }
    console.log("Build complete.");
  }
} finally {
  if (!watch) {
    await ctx.dispose();
  }
}
