import * as fs from "node:fs";
import * as path from "node:path";
import { assertBundleRuntimeImports } from "./esbuild-bundle-guard.mjs";

const repoRoot = process.cwd();
const metaPath = path.join(repoRoot, "dist", "extension.meta.json");

if (!fs.existsSync(metaPath)) {
  console.error("verify-bundle-meta: missing dist/extension.meta.json (run esbuild first)");
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
assertBundleRuntimeImports(meta, repoRoot);

const bundlePath = path.join(repoRoot, "dist", "extension.js");
const bundleText = fs.readFileSync(bundlePath, "utf8");
if (bundleText.includes("runSqlitePythonExecutescriptUnchecked")) {
  console.error(
    "verify-bundle-meta: dist must not export runSqlitePythonExecutescriptUnchecked (test-only)"
  );
  process.exit(1);
}

console.log("verify-bundle-meta: OK");
