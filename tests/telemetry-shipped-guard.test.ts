import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

const FORBIDDEN_DIST_PATTERNS = [
  /api_secret/i,
  /google-analytics\.com\/mp\/collect/i,
  /GA4_MEASUREMENT_ID/i,
  /GA4_API_SECRET/i,
];

describe("telemetry secrets do not ship in extension bundle", () => {
  it("dist/extension.js has no GA4 Measurement Protocol markers", () => {
    const bundlePath = path.join(repoRoot, "dist", "extension.js");
    expect(fs.existsSync(bundlePath)).toBe(true);
    const text = fs.readFileSync(bundlePath, "utf8");
    for (const pattern of FORBIDDEN_DIST_PATTERNS) {
      expect(text, pattern.toString()).not.toMatch(pattern);
    }
  });

  it("src/analytics.ts does not define Measurement Protocol secrets", () => {
    const srcPath = path.join(repoRoot, "src", "analytics.ts");
    const text = fs.readFileSync(srcPath, "utf8");
    expect(text).not.toMatch(/api_secret/i);
    expect(text).not.toMatch(/google-analytics\.com\/mp\/collect/i);
    expect(text).toContain("/v1/telemetry");
  });
});