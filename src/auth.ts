import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { withRetry } from "./retry.js";
import { getLogger, loadSyncState, saveSyncState } from "./diagnostics.js";
import { updateStatusBar } from "./statusbar.js";
import { refreshSidebar } from "./sidebar.js";
import { sendEvent } from "./analytics.js";

const SECRET_KEY = "cursorSync.githubPAT";

export async function configureGithub(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const pat = await vscode.window.showInputBox({
    prompt: "Enter your GitHub Personal Access Token (requires gist scope)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "ghp_xxxxxxxxxxxx",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Token cannot be empty";
      }
      return undefined;
    },
  });

  if (!pat) {
    return;
  }

  const client = new GistClient(pat.trim());
  const result = await withRetry(() => client.validateToken());

  if (!result.ok) {
    logger.appendLine(
      `[${new Date().toISOString()}] Token validation failed: ${result.error.message}`
    );
    vscode.window.showErrorMessage(
      `GitHub token validation failed: ${result.error.message}`
    );
    return;
  }

  await context.secrets.store(SECRET_KEY, pat.trim());
  await vscode.commands.executeCommand("setContext", "cursorSync.configured", true);

  const syncState = await loadSyncState(context);
  const lastSync = syncState ? new Date(syncState.lastSyncTimestamp) : undefined;
  updateStatusBar("ok", lastSync);
  
  vscode.window.showInformationMessage("GitHub token configured successfully.");
  logger.appendLine(`[${new Date().toISOString()}] GitHub token configured`);

  try {
    const existingGistResult = await withRetry(() => client.findExistingGist());
    if (existingGistResult.ok && existingGistResult.data) {
      sendEvent(context, "user_configured", { has_existing_gist: true });
      const gistId = existingGistResult.data.id;
      const syncState = await loadSyncState(context);
      if (!syncState || syncState.gistId !== gistId) {
        await saveSyncState(context, {
          lastSyncTimestamp: syncState?.lastSyncTimestamp || new Date().toISOString(),
          lastSyncDirection: syncState?.lastSyncDirection || "pull",
          gistId: gistId,
          localChecksums: syncState?.localChecksums || {},
          remoteChecksums: syncState?.remoteChecksums || {},
        });
        logger.appendLine(`[${new Date().toISOString()}] Discovered existing Gist: ${gistId}`);
        vscode.window.showInformationMessage("Found existing Cursor Sync Gist. You can now pull your settings.");
        
        const newSyncState = await loadSyncState(context);
        updateStatusBar("ok", newSyncState ? new Date(newSyncState.lastSyncTimestamp) : undefined);
        refreshSidebar();
      }
    } else {
      sendEvent(context, "user_configured", { has_existing_gist: false });
    }
  } catch (err) {
    logger.appendLine(`[${new Date().toISOString()}] Error discovering existing Gist: ${err instanceof Error ? err.message : String(err)}`);
    sendEvent(context, "user_configured", { has_existing_gist: false });
  }
}

export async function getToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function requireToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const token = await getToken(context);
  if (!token) {
    const action = await vscode.window.showWarningMessage(
      "GitHub token not configured. Configure now?",
      "Configure"
    );
    if (action === "Configure") {
      await configureGithub(context);
      return getToken(context);
    }
    return undefined;
  }
  return token;
}

export async function validateStoredToken(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const token = await getToken(context);
  if (!token) {
    return false;
  }

  const client = new GistClient(token);
  const result = await withRetry(() => client.validateToken());

  if (!result.ok) {
    vscode.window.showErrorMessage(
      "Stored GitHub token is no longer valid. Please reconfigure."
    );
    await vscode.commands.executeCommand("setContext", "cursorSync.configured", false);
    updateStatusBar("unconfigured");
    return false;
  }

  return true;
}
