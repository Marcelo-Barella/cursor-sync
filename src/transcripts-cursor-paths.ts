import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import { resolveExtensionSyncRoots } from "./sync-roots.js";

export function resolveChatsRoot(context?: vscode.ExtensionContext): string {
  const roots = resolveExtensionSyncRoots(context);
  return path.join(roots.dotCursor, "chats");
}

async function storeDbExists(storePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(storePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function findWorkspaceKeysForConversation(
  conversationId: string,
  context?: vscode.ExtensionContext
): Promise<string[]> {
  const chatsRoot = resolveChatsRoot(context);
  let workspaceEntries: import("node:fs").Dirent[];
  try {
    workspaceEntries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory()) continue;
    const storePath = path.join(
      chatsRoot,
      workspaceEntry.name,
      conversationId,
      "store.db"
    );
    if (await storeDbExists(storePath)) {
      matches.push(workspaceEntry.name);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

export async function findStoreDbForConversation(
  conversationId: string,
  context?: vscode.ExtensionContext
): Promise<{ absolutePath: string; workspaceKey: string } | undefined> {
  const workspaceKeys = await findWorkspaceKeysForConversation(conversationId, context);
  const workspaceKey = workspaceKeys[0];
  if (!workspaceKey) {
    return undefined;
  }
  return {
    absolutePath: path.join(resolveChatsRoot(context), workspaceKey, conversationId, "store.db"),
    workspaceKey,
  };
}
