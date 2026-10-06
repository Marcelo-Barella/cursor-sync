import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWLIST = new Set([
  path.join("src", "paths.ts"),
  path.join("src", "os-runtime.ts"),
]);

const OS_IMPORT =
  /import\s+[^;]*\bfrom\s+["'](?:node:)?os["']|require\s*\(\s*["'](?:node:)?os["']\s*\)/;
const PROCESS_ENV_PATH =
  /process\.env\s*(?:\[["'](?:HOME|USERPROFILE|APPDATA|CURSOR_DOT_DIR|XDG_CONFIG_HOME)["']\]|\.(?:HOME|USERPROFILE|APPDATA))/;

describe("sync path hardcoding guard", () => {
  it("only paths.ts and os-runtime.ts may import os or read process.env for paths", () => {
    const srcDir = path.join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const rel of collectTsFiles(srcDir)) {
      if (ALLOWLIST.has(rel)) {
        continue;
      }
      const content = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      if (OS_IMPORT.test(content)) {
        offenders.push(`${rel}: imports os`);
      }
      if (PROCESS_ENV_PATH.test(content)) {
        offenders.push(`${rel}: reads process.env for paths`);
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
