import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const SHIP_ROOTS = [
  path.join(repoRoot, "src"),
  path.join(repoRoot, "dist"),
  path.join(repoRoot, "resources"),
];

const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

function collectTextFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name)) {
      continue;
    }
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      collectTextFiles(abs, out);
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (
      ext === ".ts" ||
      ext === ".js" ||
      ext === ".mjs" ||
      ext === ".json" ||
      ext === ".md" ||
      ext === ".html" ||
      ext === ".css"
    ) {
      out.push(abs);
    }
  }
}

describe("shipped artifacts contain no bergamota host references", () => {
  it("has no case-insensitive bergamota matches under src, dist, and resources", () => {
    const files: string[] = [];
    for (const root of SHIP_ROOTS) {
      collectTextFiles(root, files);
    }
    const pattern = /bergamota/i;
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (pattern.test(text)) {
        hits.push(path.relative(repoRoot, file));
      }
    }
    expect(hits).toEqual([]);
  });
});