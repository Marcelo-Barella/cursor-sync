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

  it("rejects false-positive failure messages that mention abort/cancel substrings", () => {
    expect(isAbortLikeError(new Error("could not cancel remote dirty"))).toBe(false);
    const connAborted = Object.assign(new Error("read ECONNABORTED"), {
      code: "ECONNABORTED",
    });
    expect(isAbortLikeError(connAborted)).toBe(false);
    expect(isAbortLikeError(new Error("RequestAborted"))).toBe(false);
    expect(isAbortLikeError(new Error("aborted due to timeout"))).toBe(false);
  });

  it("accepts intentional AbortSignal-style reason on errors", () => {
    expect(isAbortLikeError(Object.assign(new Error("The operation was aborted"), { reason: "logout" }))).toBe(
      true
    );
  });
});
