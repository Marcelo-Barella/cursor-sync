import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";

export const APP_SESSION_SECRET = "cursorSync.appSession";

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

export async function buildAuthRedirectUri(
  context: vscode.ExtensionContext
): Promise<string> {
  const callbackUri = vscode.Uri.parse(
    `${vscode.env.uriScheme}://${context.extension.id}/auth`
  );
  const externalUri = await vscode.env.asExternalUri(callbackUri);
  return externalUri.toString();
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
  return context.secrets.get(APP_SESSION_SECRET);
}

export async function setAppSession(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  await context.secrets.store(APP_SESSION_SECRET, token);
}

export async function clearAppSession(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(APP_SESSION_SECRET);
}

async function completeLoginWithCode(
  context: vscode.ExtensionContext,
  code: string
): Promise<boolean> {
  const logger = getLogger();
  try {
    const token = await exchangeCodeForSessionToken(getAppApiUrl(), code);
    await setAppSession(context, token);
    vscode.window.showInformationMessage("Logged in to Cursor Sync.");
    logger.appendLine(`[${new Date().toISOString()}] App session login succeeded`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(`[${new Date().toISOString()}] App session login failed: ${message}`);
    vscode.window.showErrorMessage(`Login failed: ${message}`);
    return false;
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
      const code = extractAuthCodeFromUri(uri);
      if (!code) {
        vscode.window.showErrorMessage("Login callback did not include a code.");
        return;
      }
      void completeLoginWithCode(context, code);
    },
  });
}
