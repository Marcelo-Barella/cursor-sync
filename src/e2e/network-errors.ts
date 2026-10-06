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

const TLS_MESSAGE_RE =
  /CERT_|ERR_TLS_|UNABLE_TO_VERIFY|self signed certificate|certificate has expired/i;

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
      if (current.name === "AbortError" || current.name === "TimeoutError") {
        codes.push("ABORT_ERR");
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return codes;
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current; depth++) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  return messages;
}

function isTlsOrCertError(err: unknown): boolean {
  return collectErrorMessages(err).some((m) => TLS_MESSAGE_RE.test(m));
}

/** True when the API host could not be reached (not TLS misconfig or bad URL). */
export function isTransientNetworkError(err: unknown): boolean {
  if (isTlsOrCertError(err)) {
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
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
    codes.includes("ABORT_ERR") ||
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
