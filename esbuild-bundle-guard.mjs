import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWLIST = new Set(["src/paths.ts", "src/os-runtime.ts"]);
const FORBIDDEN = new Set([
  "os",
  "node:os",
  "process",
  "node:process",
  "vm",
  "node:vm",
  "child_process",
  "node:child_process",
  "module",
  "node:module",
  "worker_threads",
  "node:worker_threads",
  "inspector",
  "node:inspector",
  "v8",
  "node:v8",
  "cluster",
  "node:cluster",
]);

export function assertBundleInputsUnderSrc(metafile, repoRoot) {
  const srcRoot = path.resolve(repoRoot, "src");
  const offenders = [];
  for (const inputPath of Object.keys(metafile.inputs ?? {})) {
    const normalized = inputPath.replace(/\\/g, "/");
    if (normalized.includes("node_modules")) {
      continue;
    }
    if (!normalized.startsWith("src/")) {
      continue;
    }
    if (ALLOWLIST.has(normalized)) {
      continue;
    }
    const abs = path.resolve(repoRoot, normalized);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      offenders.push(`${normalized}: cannot resolve realpath`);
      continue;
    }
    if (real !== srcRoot && !real.startsWith(srcRoot + path.sep)) {
      offenders.push(`${normalized}: realpath ${real} is outside ${srcRoot}`);
    }
  }
  if (offenders.length > 0) {
    const message =
      "Bundle inputs must resolve under src/ (realpath):\n" + offenders.join("\n");
    const err = new Error(message);
    err.offenders = offenders;
    throw err;
  }
}

export function assertBundleRuntimeImports(metafile, repoRoot = process.cwd()) {
  assertBundleInputsUnderSrc(metafile, repoRoot);
  const offenders = [];
  for (const [inputPath, input] of Object.entries(metafile.inputs ?? {})) {
    const normalized = inputPath.replace(/\\/g, "/");
    if (ALLOWLIST.has(normalized)) {
      continue;
    }
    const imports = input.imports ?? [];
    for (const entry of imports) {
      const imp = typeof entry === "string" ? entry : entry.path;
      if (!imp) {
        continue;
      }
      const bare = imp.replace(/^node:/, "");
      if (FORBIDDEN.has(imp) || FORBIDDEN.has(bare)) {
        offenders.push(`${normalized} imports ${imp}`);
      }
    }
  }
  if (offenders.length > 0) {
    const message = "Forbidden runtime imports in bundle graph:\n" + offenders.join("\n");
    const err = new Error(message);
    err.offenders = offenders;
    throw err;
  }
}
