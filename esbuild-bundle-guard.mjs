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

export function assertBundleRuntimeImports(metafile) {
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
