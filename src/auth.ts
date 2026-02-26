import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";

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
  vscode.window.showInformationMessage("GitHub token configured successfully.");
  logger.appendLine(`[${new Date().toISOString()}] GitHub token configured`);
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
    return false;
  }

  return true;
}
