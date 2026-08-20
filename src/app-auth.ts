import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";

export const APP_SESSION_SECRET = "cursorSync.appSession";
const SECRET_STORAGE_TIMEOUT_MS = 2000;

class SecretStorageTimeoutError extends Error {
  constructor() {
    super("SecretStorage operation timed out");
    this.name = "SecretStorageTimeoutError";
  }
}

async function withSecretStorageTimeout<T>(
  operation: Thenable<T>,
  timeoutMs = SECRET_STORAGE_TIMEOUT_MS
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new SecretStorageTimeoutError()),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function logAppSessionLoginSucceeded(): void {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] App session login succeeded`);
  logger.show();
}

function retainInMemoryAppSession(token: string, detail: string): void {
  const logger = getLogger();
  inMemoryAppSession = token;
  logger.appendLine(
    `[${new Date().toISOString()}] App session SecretStorage store did not complete (${detail}); session kept in extension memory for this window only and will not survive restart`
  );
  vscode.window.showInformationMessage(
    "Logged in for this window only. The session will not persist after reload."
  );
}

let inMemoryAppSession: string | undefined;
let pendingAuthCallbackUri: vscode.Uri | undefined;
let appAuthActivateReady = false;
const consumedAuthCodes = new Set<string>();
let inFlightAuthCode: string | undefined;

export function getAppApiUrl(): string {
  return (
    vscode.workspace.getConfiguration("cursorSync").get<string>("appApiUrl") ??
    "http://localhost:8100"
  );
}

export function extractAuthCodeFromUri(uri: vscode.Uri): string | undefined {
  const params = new URLSearchParams(uri.query);
  const code = params.get("code");
  return code && code.trim().length > 0 ? code.trim() : undefined;
}

export function isAuthCallbackUri(uri: vscode.Uri, extensionId: string): boolean {
  return (
    uri.authority.toLowerCase() === extensionId.toLowerCase() && uri.path === "/auth"
  );
}

export function parseAuthCallbackUriFromString(
  value: string,
  extensionId: string,
  uriScheme: string
): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(value);
    if (uri.scheme !== uriScheme) {
      return undefined;
    }
    if (!isAuthCallbackUri(uri, extensionId)) {
      return undefined;
    }
    if (!extractAuthCodeFromUri(uri)) {
      return undefined;
    }
    return uri;
  } catch {
    return undefined;
  }
}

export function findAuthCallbackUriInArgv(
  argv: readonly string[],
  extensionId: string,
  uriScheme: string
): vscode.Uri | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--open-url" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        const uri = parseAuthCallbackUriFromString(next, extensionId, uriScheme);
        if (uri) {
          return uri;
        }
      }
    }
    if (arg.startsWith("--open-url=")) {
      const uri = parseAuthCallbackUriFromString(
        arg.slice("--open-url=".length),
        extensionId,
        uriScheme
      );
      if (uri) {
        return uri;
      }
    }
    const uri = parseAuthCallbackUriFromString(arg, extensionId, uriScheme);
    if (uri) {
      return uri;
    }
  }
  return undefined;
}

export async function buildAuthRedirectUri(
  context: vscode.ExtensionContext
): Promise<string> {
  const callbackUri = vscode.Uri.parse(
    `${vscode.env.uriScheme}://${context.extension.id}/auth`
  );
  const externalUri = await vscode.env.asExternalUri(callbackUri);
  return externalUri.with({ authority: context.extension.id }).toString();
}

export async function exchangeCodeForSessionToken(
  apiBase: string,
  code: string
): Promise<string> {
  const base = apiBase.replace(/\/$/, "");
  const response = await fetch(`${base}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Token exchange failed (${response.status})${text ? `: ${text}` : ""}`
    );
  }
  const data = (await response.json()) as { token?: string };
  if (!data.token || typeof data.token !== "string") {
    throw new Error("Token exchange response missing token");
  }
  return data.token;
}

export async function getAppSession(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  try {
    const secret = await withSecretStorageTimeout(
      context.secrets.get(APP_SESSION_SECRET)
    );
    if (secret) {
      return secret;
    }
  } catch {
    // SecretStorage unavailable, hung, or empty; use in-memory session for this window.
  }
  return inMemoryAppSession;
}

export async function setAppSession(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] App session: storing to SecretStorage (${APP_SESSION_SECRET})...`
  );
  try {
    await withSecretStorageTimeout(context.secrets.store(APP_SESSION_SECRET, token));
    logger.appendLine(
      `[${new Date().toISOString()}] App session: SecretStorage store completed`
    );
    inMemoryAppSession = undefined;
  } catch (err) {
    const detail =
      err instanceof SecretStorageTimeoutError
        ? "timed out waiting for SecretStorage (keyring prompt may be open)"
        : err instanceof Error
          ? err.message
          : String(err);
    retainInMemoryAppSession(token, detail);
  }
}

export async function clearAppSession(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    await withSecretStorageTimeout(context.secrets.delete(APP_SESSION_SECRET));
  } catch {
    // Clear in-memory session even when SecretStorage is unavailable or hung.
  }
  inMemoryAppSession = undefined;
}

async function completeLoginWithCode(
  context: vscode.ExtensionContext,
  code: string
): Promise<boolean> {
  if (consumedAuthCodes.has(code)) {
    return true;
  }
  if (inFlightAuthCode === code) {
    return false;
  }

  const logger = getLogger();
  inFlightAuthCode = code;
  try {
    const token = await exchangeCodeForSessionToken(getAppApiUrl(), code);
    consumedAuthCodes.add(code);
    await setAppSession(context, token);
    logAppSessionLoginSucceeded();
    vscode.window.showInformationMessage("Logged in to Cursor Sync.");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[${new Date().toISOString()}] App session login failed: ${message}`);
    logger.show();
    vscode.window.showErrorMessage(`Login failed: ${message}`);
    return false;
  } finally {
    if (inFlightAuthCode === code) {
      inFlightAuthCode = undefined;
    }
  }
}

function handleAuthCallbackUri(
  context: vscode.ExtensionContext,
  uri: vscode.Uri
): void {
  if (!isAuthCallbackUri(uri, context.extension.id)) {
    return;
  }
  const code = extractAuthCodeFromUri(uri);
  if (!code) {
    vscode.window.showErrorMessage("Login callback did not include a code.");
    return;
  }
  void completeLoginWithCode(context, code);
}

export function consumePendingAuthCallback(context: vscode.ExtensionContext): void {
  appAuthActivateReady = true;

  const pending = pendingAuthCallbackUri;
  pendingAuthCallbackUri = undefined;
  if (pending) {
    handleAuthCallbackUri(context, pending);
    return;
  }

  const argvUri = findAuthCallbackUriInArgv(
    process.argv,
    context.extension.id,
    vscode.env.uriScheme
  );
  if (argvUri) {
    handleAuthCallbackUri(context, argvUri);
  }
}

export async function executeLoginToCursorSync(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  try {
    const redirectUri = await buildAuthRedirectUri(context);
    const apiBase = getAppApiUrl().replace(/\/$/, "");
    const loginUrl = `${apiBase}/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
    const opened = await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
    if (!opened) {
      vscode.window.showErrorMessage("Could not open the system browser for login.");
      return;
    }
    logger.appendLine(`[${new Date().toISOString()}] Opened app login URL`);
    void vscode.window
      .showInformationMessage(
        "Browser opened for Cursor Sync login. If Cursor does not receive the callback, paste the one-time code from the login page.",
        "Paste code"
      )
      .then((action) => {
        if (action === "Paste code") {
          void executeEnterAppAuthCode(context);
        }
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[${new Date().toISOString()}] App login start failed: ${message}`);
    vscode.window.showErrorMessage(`Could not start login: ${message}`);
  }
}

export async function executeEnterAppAuthCode(
  context: vscode.ExtensionContext
): Promise<void> {
  const code = await vscode.window.showInputBox({
    prompt: "Paste the one-time login code from the browser",
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Code cannot be empty";
      }
      return undefined;
    },
  });
  if (!code) {
    return;
  }
  await completeLoginWithCode(context, code.trim());
}

export function registerAppAuthUriHandler(
  context: vscode.ExtensionContext
): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
      if (!isAuthCallbackUri(uri, context.extension.id)) {
        return;
      }
      if (!appAuthActivateReady) {
        pendingAuthCallbackUri = uri;
        return;
      }
      handleAuthCallbackUri(context, uri);
    },
  });
}
