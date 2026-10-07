import { describe, expect, it } from "vitest";
import { isAbortLikeError } from "../src/app-config-errors.js";

describe("isAbortLikeError", () => {
  it("accepts bare abort reason string logout", () => {
    expect(isAbortLikeError("logout")).toBe(true);
  });

  it("accepts AbortError and DOMException AbortError", () => {
    expect(isAbortLikeError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortLikeError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true
    );
  });
});
