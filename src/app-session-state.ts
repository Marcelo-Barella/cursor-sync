import * as vscode from "vscode";
import { clearAppSession, getAppSession, clearPersistedAuthHandoff } from "./app-auth.js";
import { getAppApiUrl } from "./config/urls.js";
import { resolveAppSessionEmail } from "./app-session-identity.js";

export const APP_SESSION_USER_EMAIL_KEY = "cursorSync.appSession.userEmail";
export const APP_SESSION_EXPIRED_KEY = "cursorSync.appSession.expired";
export const APP_LOGIN_API_BASE_OVERRIDE_KEY = "cursorSync.appSession.loginApiBaseOverride";
export const APP_STORAGE_E2E_KEY_SECRET = "cursorSync.appStorage.e2eKey";

export async function persistAppSessionMetadata(
  context: vscode.ExtensionContext,
  sessionToken: string
): Promise<void> {
  const email = resolveAppSessionEmail(sessionToken);
  await context.globalState.update(APP_SESSION_USER_EMAIL_KEY, email);
  await context.globalState.update(APP_SESSION_EXPIRED_KEY, false);
  await context.globalState.update(APP_LOGIN_API_BASE_OVERRIDE_KEY, getAppApiUrl());
}

export async function readCachedAppSessionEmail(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const cached = context.globalState.get<string>(APP_SESSION_USER_EMAIL_KEY);
  if (cached) {
    return cached;
  }
  const session = await getAppSession(context);
  if (!session) {
    return undefined;
  }
  return resolveAppSessionEmail(session);
}

export async function clearAppSessionArtifacts(
  context: vscode.ExtensionContext
): Promise<void> {
  await clearAppSession(context);
  await clearPersistedAuthHandoff(context);
  await context.globalState.update(APP_SESSION_USER_EMAIL_KEY, undefined);
  await context.globalState.update(APP_SESSION_EXPIRED_KEY, undefined);
  await context.globalState.update(APP_LOGIN_API_BASE_OVERRIDE_KEY, undefined);
  try {
    await context.secrets.delete(APP_STORAGE_E2E_KEY_SECRET);
  } catch {
    // SecretStorage unavailable.
  }
}
