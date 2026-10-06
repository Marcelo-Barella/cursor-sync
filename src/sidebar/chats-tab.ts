import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { listConversationsForWorkspace } from "../chat-export-ux.js";
import { __chatPersistenceInternals } from "../transcripts.js";
import { resolveExtensionSyncRoots } from "../sync-roots.js";
import type { ConversationExportRow } from "../chat-export-ux.js";
import type { BundleDiscoveryEntry } from "./bundle-discovery.js";
import { listLocalBundles } from "./bundle-discovery.js";
import { listImports } from "./import-history.js";
import type { ChatImportHistoryEntry } from "./import-history.js";
import { emitChatImportProgress } from "../chat-progress-events.js";
import {
  formatFidelityDetailLine,
  type ChatBundleFidelitySummary,
} from "../chat-bundle-fidelity.js";

export function publishImportFidelitySummary(
  conversationId: string,
  summary: ChatBundleFidelitySummary
): void {
  emitChatImportProgress({
    conversationId,
    phase: "B",
    step: "fidelity-summary",
    detail: formatFidelityDetailLine(summary),
    ok: !summary.textOnlyLayer4,
    fidelity: summary,
  });
}

export function fidelityFieldsForImportHistory(
  summary: ChatBundleFidelitySummary
): Pick<
  ChatImportHistoryEntry,
  "schemaVersion" | "diskKvRowCount" | "toolBubbleCount" | "textOnlyLayer4" | "fidelityWarnings"
> {
  return {
    schemaVersion: summary.schemaVersion,
    diskKvRowCount: summary.diskKvRowCount,
    toolBubbleCount: summary.toolBubbleCount,
    textOnlyLayer4: summary.textOnlyLayer4,
    fidelityWarnings: summary.warnings.length > 0 ? summary.warnings : undefined,
  };
}

function resolveChatsRoot(): string {
  return __chatPersistenceInternals.resolveChatsRoot();
}

export interface ChatsRecentResult {
  rows: ConversationExportRow[];
}

export interface ChatsImportsResult {
  rows: ChatImportHistoryEntry[];
}

export interface ChatsBundlesResult {
  entries: BundleDiscoveryEntry[];
}

function resolveProjectsRoot(): string {
  const { dotCursor } = resolveExtensionSyncRoots();
  return path.join(dotCursor, "projects");
}

export async function listLocalConversations(): Promise<ChatsRecentResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { rows: [] };
  }
  const folder = folders[0];
  if (!folder) {
    return { rows: [] };
  }
  const workspaceKey = crypto
    .createHash("md5")
    .update(folder.uri.fsPath)
    .digest("hex");
  const chatsRoot = resolveChatsRoot();
  const projectsRoot = resolveProjectsRoot();
  try {
    const rows = await listConversationsForWorkspace(workspaceKey, chatsRoot, projectsRoot);
    return { rows };
  } catch {
    return { rows: [] };
  }
}

export function listImportHistory(
  context: vscode.ExtensionContext
): ChatsImportsResult {
  return { rows: listImports(context) };
}

export async function listBundles(
  context: vscode.ExtensionContext
): Promise<ChatsBundlesResult> {
  const entries = await listLocalBundles(context);
  return { entries };
}

export async function openTranscriptForConversation(
  conversationId: string
): Promise<boolean> {
  const { dotCursor } = resolveExtensionSyncRoots();
  const projectsRoot = path.join(dotCursor, "projects");
  let projectDirs: import("node:fs").Dirent[];
  try {
    const fs = await import("node:fs/promises");
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const transcriptDir = path.join(
      projectsRoot,
      proj.name,
      "agent-transcripts",
      conversationId
    );
    try {
      const fs = await import("node:fs/promises");
      const files = await fs.readdir(transcriptDir);
      const jsonl = files.find((f) => f.endsWith(".jsonl"));
      if (!jsonl) continue;
      const uri = vscode.Uri.file(path.join(transcriptDir, jsonl));
      await vscode.commands.executeCommand("vscode.open", uri);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function revealTranscriptsForConversation(
  conversationId: string
): Promise<void> {
  const { dotCursor } = resolveExtensionSyncRoots();
  const projectsRoot = path.join(dotCursor, "projects");
  let projectDirs: import("node:fs").Dirent[];
  try {
    const fs = await import("node:fs/promises");
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const transcriptDir = path.join(
      projectsRoot,
      proj.name,
      "agent-transcripts",
      conversationId
    );
    try {
      const fs = await import("node:fs/promises");
      await fs.stat(transcriptDir);
      const uri = vscode.Uri.file(transcriptDir);
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    } catch {
      continue;
    }
  }
  vscode.window.showWarningMessage(
    `No transcript directory found for conversation ${conversationId}`
  );
}
