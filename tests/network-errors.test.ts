import { describe, expect, it } from "vitest";
import {
  extractNestedCauseCodes,
  isTransientNetworkError,
  userFriendlyConnectivityMessage,
} from "../src/e2e/network-errors.js";

function errWithCause(message: string, code: string): Error {
  const cause = Object.assign(new Error(`cause ${code}`), { code });
  return Object.assign(new Error(message), { cause });
}

describe("isTransientNetworkError", () => {
  const offlineCodes = [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
  ] as const;

  for (const code of offlineCodes) {
    it(`classifies nested ${code} as offline`, () => {
      const err = errWithCause("fetch failed", code);
      expect(isTransientNetworkError(err)).toBe(true);
      expect(extractNestedCauseCodes(err)).toContain(code);
    });
  }

  it("classifies AbortError as offline (request timeout)", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isTransientNetworkError(err)).toBe(true);
    expect(userFriendlyConnectivityMessage(err)).toContain("timed out");
  });

  it("does not classify bare TypeError as offline", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(false);
  });

  it("fails closed on TLS certificate errors", () => {
    const err = new Error("unable to verify the first certificate: UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(isTransientNetworkError(err)).toBe(false);
    expect(userFriendlyConnectivityMessage(err)).toContain("Secure connection");
  });

  it("fails closed on ERR_TLS_CERT_ALTNAME_INVALID", () => {
    const err = errWithCause("fetch failed", "ERR_TLS_CERT_ALTNAME_INVALID");
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("maps offline errors to friendly copy", () => {
    const err = errWithCause("fetch failed", "ECONNREFUSED");
    expect(userFriendlyConnectivityMessage(err)).toContain("offline");
  });
});
