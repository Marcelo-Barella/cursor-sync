const NETWORK_ERRNO = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && NETWORK_ERRNO.has(code)) {
      return true;
    }
    const msg = err.message.toLowerCase();
    if (msg.includes("fetch failed") || msg.includes("network request failed")) {
      return true;
    }
  }
  return false;
}
