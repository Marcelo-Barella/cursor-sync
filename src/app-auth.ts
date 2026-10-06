import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { getAppApiUrl, getAppWebsiteUrl } from "./config/urls.js";
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

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
export { AUTH_STATE_TTL_MS };

export interface PendingAuthHandoff {
  nonce: string;
  expiresAtMs: number;
  redirectUri: string;
}

const PENDING_AUTH_HANDOFF_STATE_KEY = "cursorSync.appAuth.pendingHandoff";

let pendingAuthHandoff: PendingAuthHandoff | undefined;

export function generateAuthStateNonce(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function storePendingAuthHandoff(
  redirectUri: string,
  nonce: string,
  nowMs = Date.now(),
  context?: vscode.ExtensionContext
): void {
  pendingAuthHandoff = {
    nonce,
    expiresAtMs: nowMs + AUTH_STATE_TTL_MS,
    redirectUri,
  };
  if (context) {
    void context.globalState.update(PENDING_AUTH_HANDOFF_STATE_KEY, pendingAuthHandoff);
  }
}

export function readPersistedAuthHandoff(
  context: vscode.ExtensionContext,
  nowMs = Date.now()
): PendingAuthHandoff | undefined {
  const fromMemory = pendingAuthHandoff;
  if (fromMemory && nowMs <= fromMemory.expiresAtMs) {
    return fromMemory;
  }
  const fromDisk = context.globalState.get<PendingAuthHandoff>(PENDING_AUTH_HANDOFF_STATE_KEY);
  if (!fromDisk || nowMs > fromDisk.expiresAtMs) {
    return undefined;
  }
  return fromDisk;
}

export async function clearPersistedAuthHandoff(
  context: vscode.ExtensionContext
): Promise<void> {
  pendingAuthHandoff = undefined;
  await context.globalState.update(PENDING_AUTH_HANDOFF_STATE_KEY, undefined);
}

export async function resolveAuthRedirectUriForCodeExchange(
  context: vscode.ExtensionContext
): Promise<string> {
  const handoff = readPersistedAuthHandoff(context);
  if (handoff) {
    return handoff.redirectUri;
  }
  return buildAuthRedirectUri(context);
}

export type AuthStateVerificationResult =
  | { ok: true; redirectUri: string }
  | { ok: false; message: string };

export function verifyAndConsumeAuthHandoff(
  receivedState: string | undefined,
  nowMs = Date.now()
): AuthStateVerificationResult {
  const pending = pendingAuthHandoff;
  pendingAuthHandoff = undefined;

  if (!receivedState || receivedState.trim().length === 0) {
    return { ok: false, message: "Login callback did not include state." };
  }

  if (!pending) {
    return { ok: false, message: "No login in progress. Start sign-in again." };
  }

  if (nowMs > pending.expiresAtMs) {
    return { ok: false, message: "Login state expired. Start sign-in again." };
  }

  if (receivedState.trim() !== pending.nonce) {
    return { ok: false, message: "Login state did not match. Start sign-in again." };
  }

  return { ok: true, redirectUri: pending.redirectUri };
}

export function buildSignInUrl(
  websiteBase: string,
  redirectUri: string,
  state: string
): string {
  const base = websiteBase.replace(/\/+$/, "");
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
  });
  return `${base}/sign-in?${params.toString()}`;
}

export function extractAuthCodeFromUri(uri: vscode.Uri): string | undefined {
  const params = new URLSearchParams(uri.query);
  const code = params.get("code");
  return code && code.trim().length > 0 ? code.trim() : undefined;
}

export function extractAuthStateFromUri(uri: vscode.Uri): string | undefined {
  const params = new URLSearchParams(uri.query);
  const state = params.get("state");
  return state && state.trim().length > 0 ? state.trim() : undefined;
}

export function extractAuthTokenFromUri(uri: vscode.Uri): string | undefined {
  const params = new URLSearchParams(uri.query);
  const token = params.get("token");
  return token && token.trim().length > 0 ? token.trim() : undefined;
}

export function isAllowedOAuthRedirectScheme(scheme: string): boolean {
  const normalized = scheme.toLowerCase();
  return normalized === "cursor" || normalized === "vscode";
}

export function normalizeAuthCallbackPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/auth" : trimmed;
}

export function isAuthCallbackUri(uri: vscode.Uri, extensionId: string): boolean {
  if (!isAllowedOAuthRedirectScheme(uri.scheme)) {
    return false;
  }
  return (
    uri.authority.toLowerCase() === extensionId.toLowerCase() &&
    normalizeAuthCallbackPath(uri.path) === "/auth"
  );
}

export function parseAuthCallbackUriFromString(
  value: string,
  extensionId: string,
  uriScheme: string
): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(value);
    if (!isAllowedOAuthRedirectScheme(uri.scheme)) {
      return undefined;
    }
    if (!isAuthCallbackUri(uri, extensionId)) {
      return undefined;
    }
    if (extractAuthTokenFromUri(uri)) {
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

export function formatAuthCallbackUri(uriScheme: string, extensionId: string): string {
  return `${uriScheme}://${extensionId}/auth`;
}

export function formatOAuthRedirectUri(uri: vscode.Uri, extensionId: string): string {
  let normalized = uri;
  if (uri.query) {
    const params = new URLSearchParams(uri.query);
    if (params.has("windowId")) {
      params.delete("windowId");
      const query = params.toString();
      normalized = uri.with({ query });
    }
  }
  if (
    isAllowedOAuthRedirectScheme(normalized.scheme) &&
    normalized.authority.toLowerCase() === extensionId.toLowerCase()
  ) {
    normalized = normalized.with({
      authority: extensionId,
      path: normalizeAuthCallbackPath(normalized.path),
    });
  }
  return normalized.toString();
}

export async function buildAuthRedirectUri(
  context: vscode.ExtensionContext
): Promise<string> {
  const callbackUri = vscode.Uri.parse(
    formatAuthCallbackUri(vscode.env.uriScheme, context.extension.id)
  );
  const externalUri = await vscode.env.asExternalUri(callbackUri);
  return formatOAuthRedirectUri(externalUri, context.extension.id);
}

function formatTokenExchangeNetworkError(apiBase: string, err: unknown): Error {
  const base = apiBase.replace(/\/$/, "");
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `Could not reach Cursor Sync API at ${base} (${detail}). Check your network and Cursor Sync: Developer environment / API URL settings.`
  );
}

export async function exchangeCodeForSessionToken(
  apiBase: string,
  code: string,
  redirectUri?: string
): Promise<string> {
  const base = apiBase.replace(/\/$/, "");
  const body: { code: string; redirect_uri?: string } = { code };
  if (redirectUri && redirectUri.trim().length > 0) {
    body.redirect_uri = redirectUri;
  }
  let response: Response;
  try {
    response = await fetch(`${base}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw formatTokenExchangeNetworkError(base, err);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new Error(
        `Cursor Sync API not found at ${base}/auth/token (HTTP 404). Check Developer environment and API URL settings.`
      );
    }
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
  } catch {}
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
  } catch {}
  inMemoryAppSession = undefined;
  const { onAppSessionCleared } = await import("./e2e/gate.js");
  onAppSessionCleared(context);
}

async function completeLoginWithCode(
  context: vscode.ExtensionContext,
  code: string,
  redirectUri?: string
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
    const token = await exchangeCodeForSessionToken(getAppApiUrl(), code, redirectUri);
    consumedAuthCodes.add(code);
    await setAppSession(context, token);
    await clearPersistedAuthHandoff(context);
    logAppSessionLoginSucceeded();
    const { refreshSidebar } = await import("./sidebar/index.js");
    const { ensureE2eGateAfterLogin } = await import("./e2e/commands.js");
    const { KeysApiError } = await import("./e2e/keys-client.js");
    try {
      await ensureE2eGateAfterLogin(context);
    } catch (err) {
      if (err instanceof KeysApiError && err.status === 429) {
        const { refreshE2eGateContext } = await import("./e2e/gate.js");
        await refreshE2eGateContext(context, { bypassCache: true });
        refreshSidebar();
        vscode.window.showInformationMessage(
          `Logged in to Cursor Sync. Encryption key status check was deferred: ${err.message}`
        );
        return true;
      }
      throw err;
    }
    refreshSidebar();
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
  if (extractAuthTokenFromUri(uri)) {
    vscode.window.showErrorMessage(
      "Login callback must not include a token in the URL. Complete sign-in with the one-time code flow."
    );
    return;
  }
  const stateResult = verifyAndConsumeAuthHandoff(extractAuthStateFromUri(uri));
  if (!stateResult.ok) {
    vscode.window.showErrorMessage(stateResult.message);
    return;
  }
  const code = extractAuthCodeFromUri(uri);
  if (!code) {
    vscode.window.showErrorMessage("Login callback did not include a code.");
    return;
  }
  void completeLoginWithCode(context, code, stateResult.redirectUri);
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
  const { releaseSyncLatchForAuthRetry } = await import("./sync-operation.js");
  await releaseSyncLatchForAuthRetry(context);
  try {
    const redirectUri = await buildAuthRedirectUri(context);
    const state = generateAuthStateNonce();
    storePendingAuthHandoff(redirectUri, state, Date.now(), context);
    const websiteBase = getAppWebsiteUrl();
    const loginUrl = buildSignInUrl(websiteBase, redirectUri, state);
    logger.appendLine(
      `[${new Date().toISOString()}] App login redirect_uri=${redirectUri}`
    );
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
  const { releaseSyncLatchForAuthRetry } = await import("./sync-operation.js");
  await releaseSyncLatchForAuthRetry(context);
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
  const redirectUri = await resolveAuthRedirectUriForCodeExchange(context);
  await completeLoginWithCode(context, code.trim(), redirectUri);
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
