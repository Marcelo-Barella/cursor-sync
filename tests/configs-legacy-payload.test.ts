import { describe, expect, it } from "vitest";
import { hasLegacyConfigsPayload } from "../src/e2e/configs-legacy-payload.js";

describe("hasLegacyConfigsPayload", () => {
  it("treats null, undefined, and {} as no legacy payload", () => {
    expect(hasLegacyConfigsPayload(null)).toBe(false);
    expect(hasLegacyConfigsPayload(undefined)).toBe(false);
    expect(hasLegacyConfigsPayload({})).toBe(false);
  });

  it("treats cleared server payload {} after migration as empty", () => {
    expect(hasLegacyConfigsPayload({})).toBe(false);
  });

  it("detects legacy payload with files", () => {
    expect(
      hasLegacyConfigsPayload({
        schemaVersion: 1,
        manifest: {
          schemaVersion: 1,
          syncProfileName: "default",
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceMachineId: "m",
          sourceOS: "linux",
          files: { "cursor-user/settings.json": { checksum: "a", sizeBytes: 1 } },
        },
        files: {
          "cursor-user/settings.json": { content: "{}", checksum: "a", sizeBytes: 1 },
        },
      })
    ).toBe(true);
  });

  it("treats schema payload with empty files as cleared", () => {
    expect(
      hasLegacyConfigsPayload({
        schemaVersion: 1,
        manifest: {
          schemaVersion: 1,
          syncProfileName: "default",
          createdAt: "2026-01-01T00:00:00.000Z",
          sourceMachineId: "m",
          sourceOS: "linux",
          files: {},
        },
        files: {},
      })
    ).toBe(false);
  });
});
