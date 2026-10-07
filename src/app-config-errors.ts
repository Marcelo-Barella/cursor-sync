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

/** Exact abort reason strings we intentionally use (e.g. AbortSignal.abort("logout")). */
const INTENTIONAL_ABORT_REASONS = new Set(["logout"]);

export function isIntentionalAbortReason(value: string): boolean {
  return INTENTIONAL_ABORT_REASONS.has(value.trim());
}

function abortReasonFromError(error: Error): unknown {
  return (error as Error & { reason?: unknown }).reason;
}

export function isAbortLikeError(error: unknown): boolean {
  if (typeof error === "string") {
    return isIntentionalAbortReason(error);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }
    if (isIntentionalAbortReason(error.message)) {
      return true;
    }
    const reason = abortReasonFromError(error);
    if (typeof reason === "string" && isIntentionalAbortReason(reason)) {
      return true;
    }
  }
  return false;
}
