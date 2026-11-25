import { describe, expect, it } from "vitest";
import { shouldPullAppConfigFile } from "../src/app-storage-baseline.js";

describe("app storage pull skips unchanged files", () => {
  it("does not pull when local checksum matches remote manifest", () => {
    expect(shouldPullAppConfigFile("abc123", "abc123")).toBe(false);
  });

  it("pulls when local file is missing", () => {
    expect(shouldPullAppConfigFile(undefined, "abc123")).toBe(true);
  });

  it("pulls when local checksum differs from remote", () => {
    expect(shouldPullAppConfigFile("local", "remote")).toBe(true);
  });
});
