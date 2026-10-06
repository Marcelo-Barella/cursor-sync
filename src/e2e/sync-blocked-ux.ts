import * as vscode from "vscode";
import { E2E_LOCKED_SYNC_MESSAGE } from "./gate.js";

export async function showE2eSyncBlockedMessage(message: string): Promise<void> {
  if (message === E2E_LOCKED_SYNC_MESSAGE) {
    const action = await vscode.window.showWarningMessage(message, "Unlock");
    if (action === "Unlock") {
      await vscode.commands.executeCommand("cursorSync.e2e.unlock");
    }
    return;
  }
  void vscode.window.showWarningMessage(message);
}
