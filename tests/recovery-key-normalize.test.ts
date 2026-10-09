import { describe, expect, it } from "vitest";
import { formatRecoveryKeyForDisplay, generateRecoveryKeyBytes, parseRecoveryKeyInput } from "../src/e2e/recovery-key.js";

describe("recovery key input normalization", () => {
  it("accepts lowercase, spaces, dashes, and I/L/O substitutions", () => {
    const bytes = generateRecoveryKeyBytes();
    const formatted = formatRecoveryKeyForDisplay(bytes);
    const noisy = formatted.toLowerCase().replace(/-/g, " ").replace(/0/g, "o");
    const round = parseRecoveryKeyInput(noisy);
    expect(round.subarray(0, 32).equals(bytes.subarray(0, 32))).toBe(true);
  });
});
