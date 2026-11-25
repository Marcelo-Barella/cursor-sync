import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "src");

const ALLOWED_BEARER_FILES = new Set([
  "src/app-api-http.ts",
  "src/gist.ts",
]);

function collectTsFiles(dir: string, base = "src"): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

describe("authorization bearer guard", () => {
  it("forbids Authorization headers outside app-api-http and GitHub gist client", () => {
    const offenders: string[] = [];
    for (const rel of collectTsFiles(srcDir)) {
      if (ALLOWED_BEARER_FILES.has(rel)) {
        continue;
      }
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      if (/\bAuthorization\b/.test(text) || /Bearer\s*`/.test(text) || /Bearer \$\{/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});