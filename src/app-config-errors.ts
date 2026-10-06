export class AppConfigsSessionExpiredError extends Error {
  constructor() {
    super("session_expired");
    this.name = "AppConfigsSessionExpiredError";
  }
}

export function isAppConfigsSessionExpiredError(error: unknown): boolean {
  return (
    error instanceof AppConfigsSessionExpiredError ||
    (error instanceof Error && error.name === "AppConfigsSessionExpiredError")
  );
}

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return false;
}
