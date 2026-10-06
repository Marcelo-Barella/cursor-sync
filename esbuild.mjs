import * as esbuild from "esbuild";

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

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching...");
} else {
  const result = await esbuild.build({ ...buildOptions, metafile: true });
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(
      "dist/extension.meta.json",
      JSON.stringify(result.metafile, null, 2),
      "utf8"
    )
  );
  const { spawnSync } = await import("node:child_process");
  const check = spawnSync("node", ["scripts/check-bundle-runtime-imports.mjs"], {
    stdio: "inherit",
  });
  if (check.status !== 0) {
    process.exit(check.status ?? 1);
  }
  console.log("Build complete.");
}
