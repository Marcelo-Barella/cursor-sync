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
