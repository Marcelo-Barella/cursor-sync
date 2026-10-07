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

const ABORT_REASON_LITERALS = new Set(["logout", "abort", "cancel", "cancelled", "canceled"]);

function stringLooksAbortLike(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (ABORT_REASON_LITERALS.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("abort") ||
    normalized.includes("cancel") ||
    normalized.includes("logout")
  );
}

function abortReasonFromError(error: Error): unknown {
  return (error as Error & { reason?: unknown }).reason;
}

export function isAbortLikeError(error: unknown): boolean {
  if (typeof error === "string") {
    return stringLooksAbortLike(error);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }
    if (stringLooksAbortLike(error.message)) {
      return true;
    }
    const reason = abortReasonFromError(error);
    if (typeof reason === "string" && stringLooksAbortLike(reason)) {
      return true;
    }
  }
  return false;
}
