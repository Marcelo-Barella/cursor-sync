import * as vscode from "vscode";

const LOGOUT_FORCE_PROMPT_MS = 120_000;
const SERVER_LOGOUT_TIMEOUT_MS = 2000;

let sessionEpoch = 0;
let loggingOut = false;
let logoutInProgress: Promise<void> | undefined;
let logoutProgress: vscode.Progress<{ message?: string }> | undefined;

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

export class LoggingOutError extends Error {
  constructor() {
    super("logging_out");
    this.name = "LoggingOutError";
  }
}

export function isAppConfigsAbortedError(error: unknown): error is AppConfigsAbortedError {
  return (
    error instanceof AppConfigsAbortedError ||
    (error instanceof Error && error.name === "AppConfigsAbortedError")
  );
}

export function isLoggingOut(): boolean {
  return loggingOut;
}

export function getLogoutInProgressPromise(): Promise<void> | undefined {
  return logoutInProgress;
}

export function setLogoutInProgress(promise: Promise<void> | undefined): void {
  logoutInProgress = promise;
}

export function setLoggingOut(value: boolean): void {
  loggingOut = value;
}

export function reportLogoutProgress(message: string): void {
  logoutProgress?.report({ message });
}

export function bindLogoutProgress(progress: vscode.Progress<{ message?: string }>): void {
  logoutProgress = progress;
}

export function clearLogoutProgress(): void {
  logoutProgress = undefined;
}

export function assertSyncNotBlockedByLogout(): void {
  if (loggingOut) {
    vscode.window.showInformationMessage("Logging out…");
    throw new LoggingOutError();
  }
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
  assertSyncNotBlockedByLogout();
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

async function waitForActiveRunToFinish(): Promise<void> {
  if (!activeAppConfigsRun) {
    return;
  }
  await activeAppConfigsRun.done;
}

async function waitForPullFinalize(): Promise<void> {
  if (!pendingPullFinalize) {
    return;
  }
  await pendingPullFinalize;
}

export async function waitForAppConfigsLogoutDrain(
  options?: { force?: boolean }
): Promise<void> {
  if (activeAppConfigsRun) {
    activeAppConfigsRun.logoutAbort = true;
    activeAppConfigsRun.abortController.abort("logout");
  }
  reportLogoutProgress("Stopping sync…");
  await waitForActiveRunToFinish();
  reportLogoutProgress("Restoring files…");
  await waitForPullFinalize();
  if (options?.force) {
    return;
  }
}

export async function abortAppConfigsForLogout(): Promise<void> {
  const started = Date.now();
  await waitForAppConfigsLogoutDrain();
  while (Date.now() - started < LOGOUT_FORCE_PROMPT_MS) {
    if (!activeAppConfigsRun && !pendingPullFinalize) {
      return;
    }
    await waitForAppConfigsLogoutDrain();
    if (!activeAppConfigsRun && !pendingPullFinalize) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  const choice = await vscode.window.showWarningMessage(
    "Logout is still waiting for app config files to finish restoring. Logging out now may leave some files half-updated.",
    { modal: true },
    "Log out anyway",
    "Keep waiting"
  );
  if (choice === "Log out anyway") {
    await waitForAppConfigsLogoutDrain({ force: true });
    return;
  }
  while (activeAppConfigsRun || pendingPullFinalize) {
    reportLogoutProgress("Restoring files…");
    await waitForAppConfigsLogoutDrain();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

/** Test-only reset of module singletons (Vitest isolation). */
export function __resetAppSessionCoordinationForTests(): void {
  loggingOut = false;
  logoutInProgress = undefined;
  logoutProgress = undefined;
  sessionEpoch = 0;
  activeAppConfigsRun = undefined;
  pendingPullFinalize = undefined;
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
