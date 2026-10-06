const LOGOUT_ABORT_WAIT_MS = 5000;
const LOGOUT_PULL_FINALIZE_WAIT_MS = 120_000;
const SERVER_LOGOUT_TIMEOUT_MS = 2000;

let sessionEpoch = 0;

type AppConfigsRunType = "push" | "pull";

interface ActiveAppConfigsRun {
  type: AppConfigsRunType;
  abortController: AbortController;
  epoch: number;
  done: Promise<void>;
  resolveDone: () => void;
  logoutAbort: boolean;
}

let activeAppConfigsRun: ActiveAppConfigsRun | undefined;
let pendingPullFinalize: Promise<void> | undefined;

export function registerPullFinalize(promise: Promise<void>): void {
  pendingPullFinalize = promise;
  void promise.finally(() => {
    if (pendingPullFinalize === promise) {
      pendingPullFinalize = undefined;
    }
  });
}

export class AppConfigsAbortedError extends Error {
  readonly reason: "logout" | "abort";

  constructor(reason: "logout" | "abort" = "logout") {
    super(reason);
    this.name = "AppConfigsAbortedError";
    this.reason = reason;
  }
}

export function isAppConfigsAbortedError(error: unknown): error is AppConfigsAbortedError {
  return (
    error instanceof AppConfigsAbortedError ||
    (error instanceof Error && error.name === "AppConfigsAbortedError")
  );
}

export interface AppConfigsRunHandle {
  type: AppConfigsRunType;
  signal: AbortSignal;
  epoch: number;
  end: () => void;
}

export function getSessionEpoch(): number {
  return sessionEpoch;
}

export function bumpSessionEpoch(): void {
  sessionEpoch += 1;
  if (activeAppConfigsRun) {
    activeAppConfigsRun.logoutAbort = true;
    activeAppConfigsRun.abortController.abort("logout");
  }
}

export function beginAppConfigsRun(type: AppConfigsRunType): AppConfigsRunHandle {
  const abortController = new AbortController();
  const epoch = sessionEpoch;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  activeAppConfigsRun = {
    type,
    abortController,
    epoch,
    done,
    resolveDone,
    logoutAbort: false,
  };
  return {
    type,
    signal: abortController.signal,
    epoch,
    end: () => {
      resolveDone();
      if (activeAppConfigsRun?.abortController === abortController) {
        activeAppConfigsRun = undefined;
      }
    },
  };
}

export function wasAppConfigsLogoutAbort(): boolean {
  return activeAppConfigsRun?.logoutAbort === true;
}

export function throwIfAppConfigsAborted(run: AppConfigsRunHandle): void {
  if (run.signal.aborted || run.epoch !== sessionEpoch) {
    throw new AppConfigsAbortedError("logout");
  }
}

export async function abortAppConfigsForLogout(): Promise<void> {
  if (!activeAppConfigsRun) {
    return;
  }
  activeAppConfigsRun.logoutAbort = true;
  activeAppConfigsRun.abortController.abort("logout");
  await Promise.race([
    activeAppConfigsRun.done,
    new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_ABORT_WAIT_MS)),
  ]);
  if (pendingPullFinalize) {
    await Promise.race([
      pendingPullFinalize,
      new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_PULL_FINALIZE_WAIT_MS)),
    ]);
  }
}

export async function tryServerLogout(apiBase: string, sessionToken: string): Promise<void> {
  const base = apiBase.replace(/\/+$/, "");
  const url = `${base}/auth/logout`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVER_LOGOUT_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.status === 404) {
      return;
    }
  } catch {
    // Local logout proceeds on network errors, timeouts, and missing routes.
  }
}
