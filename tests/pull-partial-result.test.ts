import { describe, expect, it } from "vitest";
import { executePullSucceeded } from "../src/pull.js";

describe("executePull partial result", () => {
  it("is not treated as success", () => {
    expect(executePullSucceeded({ status: "partial" })).toBe(false);
    expect(executePullSucceeded({ status: "held" })).toBe(false);
    expect(executePullSucceeded({ status: "success" })).toBe(true);
  });
});
