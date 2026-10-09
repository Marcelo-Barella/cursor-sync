export class AppConfigsFetchError extends Error {
  readonly historyRecorded: boolean;

  constructor(message: string, historyRecorded: boolean) {
    super(message);
    this.name = "AppConfigsFetchError";
    this.historyRecorded = historyRecorded;
  }
}

export function isAppConfigsFetchError(err: unknown): AppConfigsFetchError | undefined {
  return err instanceof AppConfigsFetchError ? err : undefined;
}
