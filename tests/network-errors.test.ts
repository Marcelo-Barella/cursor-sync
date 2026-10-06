import { describe, expect, it } from "vitest";
import {
  API_REQUEST_TIMEOUT_MESSAGE,
  extractNestedCauseCodes,
  isTlsOrCertError,
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

  // Intentionally fail-closed: AbortSignal / fetch timeouts surface as TimeoutError or AbortError
  // without errno causes — they must not unlock from stale disk cache.
  it("does not classify TimeoutError as offline (intended fail-closed)", () => {
    const err = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("does not classify bare AbortError as offline", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("maps TimeoutError and AbortError to friendly timeout copy (fail-closed)", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(isTransientNetworkError(timeout)).toBe(false);
    expect(userFriendlyConnectivityMessage(timeout)).toBe(API_REQUEST_TIMEOUT_MESSAGE);
    const aborted = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "AbortError",
    });
    expect(userFriendlyConnectivityMessage(aborted)).toBe(API_REQUEST_TIMEOUT_MESSAGE);
  });

  it("does not classify bare TypeError as offline", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(false);
  });

  it("classifies TLS failures by cause.code", () => {
    const err = errWithCause("fetch failed", "DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(isTlsOrCertError(err)).toBe(true);
    expect(isTransientNetworkError(err)).toBe(false);
    expect(userFriendlyConnectivityMessage(err)).toContain("Secure connection");
  });

  it("classifies ERR_SSL_WRONG_VERSION_NUMBER as TLS", () => {
    const err = errWithCause("fetch failed", "ERR_SSL_WRONG_VERSION_NUMBER");
    expect(isTlsOrCertError(err)).toBe(true);
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it("does not infer TLS from message text alone", () => {
    const err = new Error("unable to verify the first certificate");
    expect(isTlsOrCertError(err)).toBe(false);
  });

  it("maps offline errors to friendly copy", () => {
    const err = errWithCause("fetch failed", "ECONNREFUSED");
    expect(userFriendlyConnectivityMessage(err)).toContain("offline");
  });
});
