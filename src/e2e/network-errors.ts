const OFFLINE_CAUSE_CODES = new Set([
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
]);

const TLS_CAUSE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

export const KEYS_GET_TIMEOUT_MS = 15_000;

export function extractNestedCauseCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current; depth++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      if (typeof code === "string" && code.length > 0) {
        codes.push(code);
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return codes;
}

function isTlsCauseCode(code: string): boolean {
  if (TLS_CAUSE_CODES.has(code)) {
    return true;
  }
  return code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_");
}

export function isTlsOrCertError(err: unknown): boolean {
  return extractNestedCauseCodes(err).some(isTlsCauseCode);
}

export function isTransientNetworkError(err: unknown): boolean {
  if (isTlsOrCertError(err)) {
    return false;
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return false;
  }
  const codes = extractNestedCauseCodes(err);
  if (codes.some((c) => OFFLINE_CAUSE_CODES.has(c))) {
    return true;
  }
  return false;
}

export function userFriendlyConnectivityMessage(err: unknown): string {
  if (isTlsOrCertError(err)) {
    return "Secure connection to the Cursor Sync API failed. Check TLS or proxy settings and try again.";
  }
  const codes = extractNestedCauseCodes(err);
  if (
    codes.includes("ETIMEDOUT") ||
    codes.includes("UND_ERR_HEADERS_TIMEOUT") ||
    codes.includes("UND_ERR_CONNECT_TIMEOUT")
  ) {
    return "Cursor Sync API request timed out. Check your connection and try again.";
  }
  if (isTransientNetworkError(err)) {
    return "Cannot reach the Cursor Sync API while offline. Check your connection and try again.";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
