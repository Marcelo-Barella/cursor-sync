import * as vscode from "vscode";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { pickChatsForExport, type ChatExportSelection } from "./chat-export-ux.js";
import { buildChatExportPayload, chatEditorExportFailureMessage } from "./chat-persistence.js";
import { encryptChatPayloadForGist } from "./e2e/chat-payload-crypto.js";
import { resolveChatEditorExportTarget } from "./chat-editor-target.js";

export { CHAT_BUNDLE_GIST_FILE_NAME, CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";

export async function exportChatSelectionToGist(
  context: vscode.ExtensionContext,
  selection: ChatExportSelection
): Promise<void> {
  const logger = getLogger();

  const token = await requireToken(context);
  if (!token) {
    logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist failed: AUTH_FAILED`);
    return;
  }

  const client = new GistClient(token);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { gistPayload, warnings, primaryTitle, bundles } = await buildChatExportPayload(
          context,
          selection,
          progress
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Chat gist export workspace=${selection.workspaceKey} count=${bundles.length}`
        );

        let gistFiles: Record<string, { content: string }>;
        try {
          gistFiles = await encryptChatPayloadForGist(
            context,
            gistPayload.content,
            gistPayload.fileName
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showWarningMessage(message);
          return;
        }
        const encrypted = true;

        const result = await withRetry(() =>
          client.createGist(gistFiles, "Cursor Sync - Chat Export")
        );

        if (!result.ok) {
          vscode.window.showErrorMessage(`Export failed: ${result.error.message}`);
          logger.appendLine(
            `[${new Date().toISOString()}] Chat export to Gist failed: ${result.error.category} - ${result.error.message}`
          );
          return;
        }

        const gistUrl = result.data.html_url;
        logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist succeeded: ${gistUrl}`);

        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-export-gist] ${w}`);
        }

        const linkNote = encrypted
          ? "Content is encrypted with sync encryption; unlock Cursor Sync to import."
          : "Anyone with the link can open it.";
        const successMsg =
          bundles.length === 1
            ? `Export successful! Chat "${primaryTitle}" in private Gist at ${gistUrl}. ${linkNote}`
            : `Export successful! ${bundles.length} chats in private Gist at ${gistUrl}. ${linkNote}`;

        const action = await vscode.window.showInformationMessage(successMsg, "Copy URL");

        if (action === "Copy URL") {
          await vscode.env.clipboard.writeText(gistUrl);
          vscode.window.showInformationMessage("Gist URL copied to clipboard.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Chat export failed: ${msg}`);
      }
    }
  );
}

export async function executeExportChatToGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist started`);

  const selection = await pickChatsForExport();
  if (!selection) {
    return;
  }

  await exportChatSelectionToGist(context, selection);
}

export async function executeExportCurrentChatBundleToGist(
  context: vscode.ExtensionContext,
  target: unknown
): Promise<void> {
  const resolution = await resolveChatEditorExportTarget(target);
  if (!resolution.ok) {
    vscode.window.showWarningMessage(chatEditorExportFailureMessage(resolution));
    return;
  }

  await exportChatSelectionToGist(context, {
    workspaceKey: resolution.target.workspaceKey,
    conversationIds: [resolution.target.conversationId],
  });
}
