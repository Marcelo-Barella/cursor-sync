import * as vscode from "vscode";
import { clearImports } from "./import-history.js";

export type SidebarMessage =
  | {
      command:
        | "syncNow"
        | "push"
        | "pull"
        | "export"
        | "import"
        | "configure"
        | "loginToApp"
        | "enterAppAuthCode";
    }
  | { command: "chats:listLocal" }
  | { command: "chats:listImports" }
  | { command: "chats:listBundles" }
  | { command: "chats:export"; conversationId: string }
  | { command: "chats:exportGist"; conversationId: string }
  | { command: "chats:importBundle"; bundlePath?: string }
  | { command: "chats:reactivate"; conversationId: string }
  | { command: "chats:revealTranscripts"; conversationId: string }
  | { command: "chats:clearHistory" }
  | { command: "settings:get" }
  | { command: "settings:set"; key: string; value: unknown };

export async function dispatchSidebarMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  msg: SidebarMessage
): Promise<void> {
  switch (msg.command) {
    case "syncNow":
      await vscode.commands.executeCommand("cursorSync.syncNow");
      break;
    case "push":
      await vscode.commands.executeCommand("cursorSync.push");
      break;
    case "pull":
      await vscode.commands.executeCommand("cursorSync.pull");
      break;
    case "export":
      await vscode.commands.executeCommand("cursorSync.export");
      break;
    case "import":
      await vscode.commands.executeCommand("cursorSync.import");
      break;
    case "configure":
      await vscode.commands.executeCommand("cursorSync.configureGithub");
      break;
    case "loginToApp":
      await vscode.commands.executeCommand("cursorSync.loginToApp");
      break;
    case "enterAppAuthCode":
      await vscode.commands.executeCommand("cursorSync.enterAppAuthCode");
      break;
    case "chats:listLocal": {
      const { listLocalConversations } = await import("./chats-tab.js");
      const result = await listLocalConversations();
      await webview.postMessage({ type: "chats:recent", rows: result.rows });
      break;
    }
    case "chats:listImports": {
      const { listImportHistory } = await import("./chats-tab.js");
      const result = listImportHistory(context);
      await webview.postMessage({ type: "chats:imports", rows: result.rows });
      break;
    }
    case "chats:listBundles": {
      const { listBundles } = await import("./chats-tab.js");
      const result = await listBundles(context);
      await webview.postMessage({ type: "chats:bundles", entries: result.entries });
      break;
    }
    case "chats:export":
      await vscode.commands.executeCommand("cursorSync.exportChatBundle");
      break;
    case "chats:exportGist":
      await vscode.commands.executeCommand("cursorSync.exportChatToGist");
      break;
    case "chats:importBundle":
      await vscode.commands.executeCommand("cursorSync.importChatBundle");
      break;
    case "chats:reactivate": {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        await webview.postMessage({
          type: "chats:reactivate:result",
          conversationId: msg.conversationId,
          ok: false,
          error: "No workspace folder open",
        });
        break;
      }
      const folder = folders[0];
      if (!folder) {
        await webview.postMessage({
          type: "chats:reactivate:result",
          conversationId: msg.conversationId,
          ok: false,
          error: "No workspace folder open",
        });
        break;
      }
      try {
        const { activateExistingChat } = await import("../chat-activate-existing.js");
        const outcome = await activateExistingChat(
          context,
          msg.conversationId,
          folder.uri
        );
        await webview.postMessage({
          type: "chats:reactivate:result",
          conversationId: msg.conversationId,
          ...outcome,
        });
      } catch (err) {
        await webview.postMessage({
          type: "chats:reactivate:result",
          conversationId: msg.conversationId,
          ok: false,
          error: String(err),
        });
      }
      break;
    }
    case "chats:revealTranscripts": {
      const { revealTranscriptsForConversation } = await import("./chats-tab.js");
      await revealTranscriptsForConversation(msg.conversationId);
      break;
    }
    case "chats:clearHistory":
      await clearImports(context);
      await webview.postMessage({ type: "chats:history-cleared" });
      break;
    case "settings:get": {
      const { readSettingsValues } = await import("./settings-tab.js");
      const values = readSettingsValues();
      await webview.postMessage({ type: "settings:current", values });
      break;
    }
    case "settings:set": {
      const { updateSettingValue } = await import("./settings-tab.js");
      await updateSettingValue(msg.key, msg.value);
      break;
    }
  }
}
