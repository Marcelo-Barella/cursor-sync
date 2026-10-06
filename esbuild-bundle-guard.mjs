import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);

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

function readRuntimeDependencyNames(repoRoot) {
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return new Set();
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const names = new Set();
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[section];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
}

function resolveInputAbsolute(inputPath, repoRoot) {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  const candidates = new Set();
  const walkRoots = [repoRoot, process.cwd()];
  for (const root of walkRoots) {
    let dir = path.resolve(root);
    for (let depth = 0; depth < 10; depth++) {
      candidates.add(path.resolve(dir, inputPath));
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  for (const abs of candidates) {
    try {
      fs.realpathSync(abs);
      return abs;
    } catch {
      // try next candidate
    }
  }
  return path.resolve(repoRoot, inputPath);
}

function packageNameFromNodeModulesRel(relFromNm) {
  const parts = relFromNm.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts[0].startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function nodeModulesPackageRoot(nmRoot, packageName) {
  return path.join(nmRoot, ...packageName.split("/"));
}

function isUnderRoot(realPath, rootPath) {
  const root = path.resolve(rootPath);
  const real = path.resolve(realPath);
  return real === root || real.startsWith(root + path.sep);
}

function declaredDepEntryPaths(nmRoot, runtimeDeps) {
  const paths = [];
  for (const dep of runtimeDeps) {
    paths.push(path.join(nmRoot, ...dep.split("/")));
  }
  return paths;
}

/** Hoisted transitive packages must resolve from a declared dependency tree, not repo root alone. */
function isReachableTransitiveRuntimeDep(pkgName, nmRoot, runtimeDeps) {
  for (const depDir of declaredDepEntryPaths(nmRoot, runtimeDeps)) {
    try {
      require.resolve(`${pkgName}/package.json`, { paths: [depDir] });
      return true;
    } catch {
      // not reachable from this declared dependency
    }
  }
  return false;
}

function assertNodeModulesInputAllowed(normalizedKey, real, nmRoot, runtimeDeps, offenders) {
  const relFromNm = path.relative(nmRoot, real);
  const pkgName = packageNameFromNodeModulesRel(relFromNm);
  if (!pkgName) {
    offenders.push(`${normalizedKey}: cannot determine package name under node_modules (${real})`);
    return;
  }

  const declared = runtimeDeps.has(pkgName);
  const transitiveOk = !declared && isReachableTransitiveRuntimeDep(pkgName, nmRoot, runtimeDeps);
  if (!declared && !transitiveOk) {
    offenders.push(
      `${normalizedKey}: realpath ${real} is under node_modules but package "${pkgName}" is not a declared or reachable runtime dependency`
    );
    return;
  }

  const pkgRoot = nodeModulesPackageRoot(nmRoot, pkgName);
  let pkgReal;
  try {
    pkgReal = fs.realpathSync(pkgRoot);
  } catch {
    offenders.push(`${normalizedKey}: cannot resolve realpath for package root ${pkgName}`);
    return;
  }
  if (!isUnderRoot(pkgReal, nmRoot)) {
    offenders.push(
      `${normalizedKey}: node_modules/${pkgName} resolves outside repo via symlink (${pkgReal})`
    );
    return;
  }
  if (!isUnderRoot(real, pkgReal)) {
    offenders.push(`${normalizedKey}: file realpath ${real} escapes package root ${pkgReal}`);
  }
}

export function assertBundleInputsUnderSrc(metafile, repoRoot) {
  const srcRoot = path.resolve(repoRoot, "src");
  const nmRoot = path.resolve(repoRoot, "node_modules");
  const runtimeDeps = readRuntimeDependencyNames(repoRoot);
  const offenders = [];

  for (const inputPath of Object.keys(metafile.inputs ?? {})) {
    const normalizedKey = inputPath.replace(/\\/g, "/");
    const abs = resolveInputAbsolute(inputPath, repoRoot);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      offenders.push(`${normalizedKey}: cannot resolve realpath (${abs})`);
      continue;
    }

    if (isUnderRoot(real, srcRoot)) {
      continue;
    }

    if (isUnderRoot(real, nmRoot)) {
      assertNodeModulesInputAllowed(normalizedKey, real, nmRoot, runtimeDeps, offenders);
      continue;
    }

    offenders.push(
      `${normalizedKey}: realpath ${real} is outside ${srcRoot} and allowed node_modules`
    );
  }

  if (offenders.length > 0) {
    const message =
      "Bundle inputs must resolve under src/ or declared runtime node_modules (realpath):\n" +
      offenders.join("\n");
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
