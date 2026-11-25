import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

type PackageJsonContributes = {
  configuration?: Array<{ properties?: Record<string, { scope?: string }> }>;
};

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
) as {
  capabilities?: {
    untrustedWorkspaces?: { restrictedConfigurations?: string[] };
  };
  contributes?: PackageJsonContributes;
};

const NETWORK_SETTINGS = [
  "cursorSync.developer.environment",
  "cursorSync.developer.apiUrl",
  "cursorSync.developer.websiteUrl",
  "cursorSync.appApiUrl",
];

function allProperties(): Record<string, { scope?: string }> {
  const merged: Record<string, { scope?: string }> = {};
  const blocks = packageJson.contributes?.configuration;
  for (const block of blocks ?? []) {
    Object.assign(merged, block.properties ?? {});
  }
  return merged;
}

describe("package.json security scopes", () => {
  it("marks network endpoint settings as application scope", () => {
    const props = allProperties();
    for (const key of NETWORK_SETTINGS) {
      expect(props[key]?.scope, key).toBe("application");
    }
  });

  it("restricts network endpoint settings in untrusted workspaces", () => {
    const restricted =
      packageJson.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    for (const key of NETWORK_SETTINGS) {
      expect(restricted, key).toContain(key);
    }
  });
});