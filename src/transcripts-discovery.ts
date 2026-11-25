import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import {
  resolveConversationDisplayTitle,
} from "./transcript-bundle.js";
import { loadComposerNameIndex } from "./composer-merge.js";
import { findStoreDbForConversation } from "./transcripts-cursor-paths.js";

export interface ProjectInfo {
  folderName: string;
  fullPath: string;
  label: string;
}

export interface TranscriptFileEntry {
  absolutePath: string;
  relativePath: string;
  projectKey: string;
}

export function resolveProjectsRoot(context?: vscode.ExtensionContext): string {
  const roots = resolveExtensionSyncRoots(context);
  return path.join(roots.dotCursor, "projects");
}

export async function discoverProjects(
  projectsRoot?: string
): Promise<ProjectInfo[]> {
  const root = projectsRoot ?? resolveProjectsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    projects.push({
      folderName: entry.name,
      fullPath,
      label: humanLabel(entry.name),
    });
  }
  return projects.sort((a, b) => a.label.localeCompare(b.label));
}

export function humanLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const withoutHash =
    parts[parts.length - 1]?.length === 40 ||
    parts[parts.length - 1]?.length === 8
      ? parts.slice(0, -1)
      : parts;
  return withoutHash.join("-");
}

/**
 * Match the open workspace folder to a Cursor project under ~/.cursor/projects/
 * (same heuristics as manual mapping: folder name encodes path + hash).
 */
export function findProjectMatchingOpenWorkspaceFolder(
  localProjects: ProjectInfo[],
  workspaceFolders?: readonly vscode.WorkspaceFolder[]
): ProjectInfo | undefined {
  const folders = workspaceFolders ?? vscode.workspace.workspaceFolders;
  if (!folders?.length || localProjects.length === 0) {
    return undefined;
  }
  const base = path.basename(folders[0].uri.fsPath);
  const lower = base.toLowerCase();
  const exact = localProjects.filter((p) => p.label.toLowerCase() === lower);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return exact.sort((a, b) => a.folderName.localeCompare(b.folderName))[0];
  }
  const loose = localProjects.filter(
    (p) =>
      p.label.toLowerCase().endsWith(lower) ||
      p.folderName.toLowerCase().includes(lower)
  );
  if (loose.length === 1) {
    return loose[0];
  }
  return undefined;
}

export function buildFallbackProjectMapping(
  sourceProjectKeys: string[],
  target: ProjectInfo
): Map<string, ProjectInfo> {
  const m = new Map<string, ProjectInfo>();
  for (const k of sourceProjectKeys) {
    m.set(k, target);
  }
  return m;
}

export async function enumerateTranscriptFiles(
  projectDir: string,
  maxBytes: number
): Promise<TranscriptFileEntry[]> {
  const transcriptsDir = path.join(projectDir, "agent-transcripts");
  const projectKey = path.basename(projectDir);
  const files: TranscriptFileEntry[] = [];

  const allFiles = await walkDir(transcriptsDir);
  for (const absPath of allFiles) {
    if (!absPath.endsWith(".jsonl")) continue;
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > maxBytes) continue;
    } catch {
      continue;
    }
    const rel = path.relative(transcriptsDir, absPath).split(path.sep).join("/");
    files.push({ absolutePath: absPath, relativePath: rel, projectKey });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export interface ExportConversationCandidate {
  projectKey: string;
  conversationId: string;
  transcriptFiles: TranscriptFileEntry[];
  hasStore: boolean;
  label: string;
  description: string;
  detail: string;
}

export async function enumerateTranscriptFilesInConversation(
  projectDir: string,
  conversationId: string,
  maxBytes: number
): Promise<TranscriptFileEntry[]> {
  const transcriptsDir = path.join(projectDir, "agent-transcripts");
  const convDir = path.join(transcriptsDir, conversationId);
  const projectKey = path.basename(projectDir);
  const files: TranscriptFileEntry[] = [];
  const allFiles = await walkDir(convDir);
  for (const absPath of allFiles) {
    if (!absPath.endsWith(".jsonl")) continue;
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > maxBytes) continue;
    } catch {
      continue;
    }
    const rel = path.relative(transcriptsDir, absPath).split(path.sep).join("/");
    files.push({ absolutePath: absPath, relativePath: rel, projectKey });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function discoverExportConversationCandidates(
  projects: ProjectInfo[],
  maxBytes: number
): Promise<ExportConversationCandidate[]> {
  const composerIndex = await loadComposerNameIndex();
  const out: ExportConversationCandidate[] = [];
  for (const proj of projects) {
    const base = path.join(proj.fullPath, "agent-transcripts");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const conversationId = ent.name;
      const transcriptFiles = await enumerateTranscriptFilesInConversation(
        proj.fullPath,
        conversationId,
        maxBytes
      );
      const storeSnapshot = await findStoreDbForConversation(conversationId);
      if (transcriptFiles.length === 0 && !storeSnapshot) {
        continue;
      }
      let primaryContent = "";
      const primaryFile =
        transcriptFiles.find((f) => path.basename(f.relativePath, ".jsonl") === conversationId) ??
        transcriptFiles[0];
      if (primaryFile) {
        try {
          primaryContent = (await fs.readFile(primaryFile.absolutePath)).toString("utf-8");
        } catch {
          primaryContent = "";
        }
      }
      const parts = [
        transcriptFiles.length > 0 ? `${transcriptFiles.length} jsonl` : "no jsonl",
        storeSnapshot ? "store.db" : "no store.db",
      ];
      out.push({
        projectKey: proj.folderName,
        conversationId,
        transcriptFiles,
        hasStore: Boolean(storeSnapshot),
        label: resolveConversationDisplayTitle({
          conversationId,
          composerName: composerIndex.get(conversationId),
          transcriptContent: primaryContent || null,
        }),
        description: `${humanLabel(proj.folderName)} · ${conversationId}`,
        detail: parts.join(" · "),
      });
    }
  }
  return out.sort((a, b) => {
    const pc = a.projectKey.localeCompare(b.projectKey);
    return pc !== 0 ? pc : a.conversationId.localeCompare(b.conversationId);
  });
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
