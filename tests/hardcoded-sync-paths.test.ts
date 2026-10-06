import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_PATTERNS = [
  /\.config\/Cursor\/User/,
  /Application Support\/Cursor\/User/,
  /AppData\/Roaming\/Cursor\/User/,
  /os\.homedir\s*\(\s*\)/,
  /path\.join\s*\(\s*os\.homedir\s*\(\s*\)\s*,\s*["']\.cursor["']/,
  /path\.join\s*\([^)]*["']\.config["']\s*,\s*["']Cursor["']\s*,\s*["']User["']\)/,
  /process\.env\.HOME/,
  /require\s*\(\s*["']os["']\s*\)\.homedir\s*\(\s*\)/,
];

const ALLOWLIST = new Set([path.join("src", "paths.ts")]);

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

  it("forbidden patterns match representative hardcoded path forms", () => {
    const samples = [
      'path.join(os.homedir(), ".cursor")',
      'path.join(foo, ".config", "Cursor", "User")',
      "const home = process.env.HOME;",
      'const home = require("os").homedir();',
    ];
    for (const sample of samples) {
      const matched = FORBIDDEN_PATTERNS.some((pattern) => pattern.test(sample));
      expect(matched).toBe(true);
    }
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
