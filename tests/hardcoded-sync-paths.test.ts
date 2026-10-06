import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_PATTERNS = [
  /\.config\/Cursor\/User/,
  /Application Support\/Cursor\/User/,
  /AppData\/Roaming\/Cursor\/User/,
];

const ALLOWLIST = new Set([
  path.join("src", "paths.ts"),
  path.join("src", "transcripts-sqlite.ts"),
  path.join("src", "transcripts-cursor-paths.ts"),
]);

describe("sync path hardcoding guard", () => {
  it("does not hardcode Cursor User or ~/.cursor outside allowlisted modules", () => {
    const srcDir = path.join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const rel of collectTsFiles(srcDir)) {
      if (ALLOWLIST.has(rel)) {
        continue;
      }
      const content = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${rel} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function collectTsFiles(dir: string, base = "src"): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts")) {
      files.push(rel);
    }
  }
  return files;
}
