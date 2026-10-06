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
  /require\s*\(\s*["']node:os["']\s*\)\.homedir\s*\(\s*\)/,
  /\bos\.userInfo\s*\(\s*\)[^.]*\.homedir/,
  /import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["']node:os["']/,
  /import\s*\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["']os["']/,
  /import\s*\{[^}]*\buserInfo\b[^}]*\}\s*from\s*["']node:os["']/,
  /import\s*\{[^}]*\buserInfo\b[^}]*\}\s*from\s*["']os["']/,
  /\bnodeOs\.homedir\s*\(\s*\)/,
  /\bos\s*\[\s*["']homedir["']\s*\]\s*\(\s*\)/,
  /const\s*\{\s*homedir\s*:\s*\w+\s*\}\s*=\s*os\b/,
  /\{\s*homedir\s*\}\s*=\s*os\b/,
  /process\.env\s*\[\s*["']HOME["']\s*\]/,
  /process\.env\.USERPROFILE/,
  /const\s*\{\s*userInfo\s*\}\s*=\s*os\b/,
  /const\s*\{\s*homedir\s*:\s*\w+\s*\}\s*=\s*nodeOs\b/,
  /process\.env\s*\[\s*["']USERPROFILE["']\s*\]/,
  /\bnodeOs\.userInfo\s*\(\s*\)\s*\.homedir/,
  /const\s*\{\s*env\s*\}\s*=\s*process\b/,
  /\benv\.HOME\b/,
  /require\s*\(\s*["']os["']\s*\)\s*\[\s*["']homedir["']\s*\]\s*\(\s*\)/,
  /const\s*\{\s*homedir\s*\}\s*=\s*require\s*\(\s*["']os["']\s*\)/,
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
      'const home = require("node:os").homedir();',
      "import { homedir } from 'node:os';",
      "import { homedir } from 'os';",
      "import { userInfo } from 'node:os';",
      "import { userInfo } from 'os';",
      "const home = nodeOs.homedir();",
      'const home = os["homedir"]();',
      "const { homedir: hd } = os;",
      "const { homedir } = os;",
      'const home = process.env["HOME"];',
      "const home = process.env.USERPROFILE;",
      "const home = os.userInfo().homedir;",
      "const { userInfo } = os;",
      "const { homedir: hd } = nodeOs;",
      'const home = process.env["USERPROFILE"];',
      "const home = nodeOs.userInfo().homedir;",
      "const { env } = process; env.HOME;",
      'const home = require("os")["homedir"]();',
      'const { homedir } = require("os");',
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
