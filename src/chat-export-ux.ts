import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { workspaceQuickPickLabel } from "./chat-workspace-label.js";
import {
  loadComposerNameIndexForChatsWorkspaceKey,
  loadGlobalComposerNameIndex,
  resolveComposerConversationTitle,
} from "./composer-title.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import { __chatPersistenceInternals } from "./transcripts.js";

function resolveChatsRoot(): string {
  return __chatPersistenceInternals.resolveChatsRoot();
}

export interface WorkspaceDir {
  name: string;
  fullPath: string;
}

export interface ConversationExportRow {
  conversationId: string;
  label: string;
  description: string;
  detail: string;
}

export interface ChatExportSelection {
  workspaceKey: string;
  conversationIds: string[];
}

export interface ListConversationsOptions {
  workspaceIndex?: Map<string, string>;
  globalIndex?: Map<string, string>;
}

function resolveProjectsRoot(): string {
  const { dotCursor } = resolveExtensionSyncRoots();
  return path.join(dotCursor, "projects");
}

export async function listChatsWorkspaceDirs(chatsRoot: string): Promise<WorkspaceDir[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(chatsRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function countJsonlForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<number> {
  let count = 0;
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    count += files.filter((f) => f.endsWith(".jsonl")).length;
  }
  return count;
}

async function readTranscriptContentForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<string | null> {
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    const jsonl = files.find((f) => f.endsWith(".jsonl"));
    if (!jsonl) continue;
    try {
      return (await fs.readFile(path.join(transcriptDir, jsonl), "utf-8")).toString();
    } catch {
      continue;
    }
  }
  return null;
}

export async function listConversationsForWorkspace(
  workspaceKey: string,
  chatsRoot: string,
  projectsRoot: string,
  options: ListConversationsOptions = {}
): Promise<ConversationExportRow[]> {
  const workspaceIndex =
    options.workspaceIndex ??
    (await loadComposerNameIndexForChatsWorkspaceKey(workspaceKey));
  const globalIndex =
    options.globalIndex ?? (await loadGlobalComposerNameIndex());
  const workspacePath = path.join(chatsRoot, workspaceKey);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: ConversationExportRow[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const conversationId = ent.name;
    const storePath = path.join(workspacePath, conversationId, "store.db");
    try {
      const stat = await fs.stat(storePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const jsonlCount = await countJsonlForConversation(projectsRoot, conversationId);
    const transcriptContent =
      (await readTranscriptContentForConversation(projectsRoot, conversationId)) ?? null;
    const title = await resolveComposerConversationTitle({
      conversationId,
      transcriptContent,
      workspaceIndex,
      globalIndex,
    });
    const parts = [
      jsonlCount > 0 ? `${jsonlCount} jsonl` : "no jsonl",
      "store.db",
    ];
    rows.push({
      conversationId,
      label: title,
      description: conversationId,
      detail: parts.join(" · "),
    });
  }
  return rows.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}

export async function pickChatsForExport(): Promise<ChatExportSelection | null> {
  const chatsRoot = resolveChatsRoot();
  const workspaces = await listChatsWorkspaceDirs(chatsRoot);

  if (workspaces.length === 0) {
    vscode.window.showErrorMessage(
      "No local chat workspaces found. Open a workspace in Cursor first."
    );
    return null;
  }

  const { cursorUser } = resolveExtensionSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);

  let workspaceKey: string;
  if (workspaces.length === 1) {
    workspaceKey = workspaces[0]!.name;
  } else {
    const pick = await vscode.window.showQuickPick(
      workspaces.map((w) => {
        const row = workspaceQuickPickLabel(w.name, folderMap);
        return { label: row.label, description: row.description, detail: w.fullPath };
      }),
      {
        title: "Select workspace for chat export",
        placeHolder: "Choose the workspace whose chats you want to export",
        ignoreFocusOut: true,
      }
    );
    if (!pick?.description) return null;
    workspaceKey = pick.description;
  }

  const projectsRoot = resolveProjectsRoot();
  const conversations = await listConversationsForWorkspace(
    workspaceKey,
    chatsRoot,
    projectsRoot
  );

  if (conversations.length === 0) {
    vscode.window.showInformationMessage("No conversations found in this workspace.");
    return null;
  }

  const convPicks = await vscode.window.showQuickPick(
    conversations.map((c) => ({
      label: c.label,
      description: c.conversationId,
      detail: c.detail,
      picked: true,
    })),
    {
      canPickMany: true,
      title: `Select conversations to export (${conversations.length} found)`,
      placeHolder:
        "Each selection exports store.db (scoped workspace), transcripts, and sidebar metadata when available",
      ignoreFocusOut: true,
    }
  );

  if (!convPicks || convPicks.length === 0) return null;

  return {
    workspaceKey,
    conversationIds: convPicks.map((p) => p.description!).filter(Boolean),
  };
}
