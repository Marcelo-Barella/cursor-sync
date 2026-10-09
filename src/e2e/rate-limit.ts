export function rateLimitMessageFromResponse(
  response: Response,
  fallbackCode = "RATE_LIMITED"
): string {
  const retryAfter = response.headers.get("Retry-After");
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? retryAfter : undefined;
  if (seconds) {
    const minutes = Math.max(1, Math.ceil(Number(seconds) / 60));
    return `Cursor Sync API rate limit reached, try again in about ${minutes} min`;
  }
  return `Cursor Sync API rate limit reached (${fallbackCode}). Try again later.`;
}
