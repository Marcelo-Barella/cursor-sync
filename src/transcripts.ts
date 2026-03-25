import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { GistClient } from "./gist.js";
import { requireToken, getToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import type { GistResponse } from "./types.js";

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

export interface TranscriptManifest {
  schemaVersion: 1;
  type: "agent-transcripts";
  createdAt: string;
  sourceMachineId: string;
  sourceOS: string;
  sourceProjects: Record<string, TranscriptProjectInfo>;
  files: Record<string, TranscriptManifestFileEntry>;
}

export interface TranscriptProjectInfo {
  folderName: string;
  fileCount: number;
}

export interface TranscriptManifestFileEntry {
  projectKey: string;
  checksum: string;
  sizeBytes: number;
}

export function resolveProjectsRoot(): string {
  const home = os.homedir();
  return path.join(home, ".cursor", "projects");
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

function humanLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const withoutHash =
    parts[parts.length - 1]?.length === 40 ||
    parts[parts.length - 1]?.length === 8
      ? parts.slice(0, -1)
      : parts;
  return withoutHash.join("-");
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

function transcriptSyncKey(projectKey: string, relativePath: string): string {
  return `transcripts/${projectKey}/${relativePath}`;
}

function syncKeyToGistFileName(syncKey: string): string {
  return syncKey.replace(/\//g, "--");
}

function gistFileNameToSyncKey(gistFileName: string): string {
  return gistFileName.replace(/--/g, "/");
}

function computeMachineId(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function executeExportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript export started`);

  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabled = config.get<boolean>("transcripts.enabled") ?? false;
  if (!enabled) {
    const action = await vscode.window.showWarningMessage(
      "Agent transcript sync is not enabled. Enable it now?",
      "Enable",
      "Cancel"
    );
    if (action !== "Enable") return;
    await config.update("transcripts.enabled", true, vscode.ConfigurationTarget.Global);
  }

  const token = await requireToken(context);
  if (!token) return;

  const maxFileSizeKB = config.get<number>("transcripts.maxFileSizeKB") ?? 2048;
  const maxBytes = maxFileSizeKB * 1024;

  const projects = await discoverProjects();
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No Cursor projects found under ~/.cursor/projects/.");
    return;
  }

  const projectPicks: vscode.QuickPickItem[] = projects.map((p) => ({
    label: p.label,
    description: p.folderName,
    picked: false,
  }));

  const selectedProjectItems = await vscode.window.showQuickPick(projectPicks, {
    canPickMany: true,
    title: "Select source projects to export transcripts from",
    placeHolder: "Choose one or more projects",
  });

  if (!selectedProjectItems || selectedProjectItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no projects selected`);
    return;
  }

  const selectedProjects = projects.filter((p) =>
    selectedProjectItems.some((item) => item.description === p.folderName)
  );

  const allFiles: TranscriptFileEntry[] = [];
  for (const proj of selectedProjects) {
    const files = await enumerateTranscriptFiles(proj.fullPath, maxBytes);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    vscode.window.showInformationMessage("No transcript files found in the selected projects.");
    return;
  }

  const filePicks: vscode.QuickPickItem[] = allFiles.map((f) => ({
    label: f.relativePath,
    description: f.projectKey,
    picked: true,
  }));

  const selectedFileItems = await vscode.window.showQuickPick(filePicks, {
    canPickMany: true,
    title: `Select transcript files to export (${allFiles.length} found)`,
    placeHolder: "Deselect files you do not want to export",
  });

  if (!selectedFileItems || selectedFileItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript export cancelled: no files selected`);
    return;
  }

  const selectedFiles = allFiles.filter((f) =>
    selectedFileItems.some(
      (item) => item.label === f.relativePath && item.description === f.projectKey
    )
  );

  const confirm = await vscode.window.showWarningMessage(
    `This will create a PUBLIC Gist with ${selectedFiles.length} transcript file(s). ` +
      "Transcripts may contain sensitive data (prompts, code, secrets). Continue?",
    { modal: true },
    "Export"
  );
  if (confirm !== "Export") return;

  const gistFiles: Record<string, { content: string }> = {};
  const manifestFiles: Record<string, TranscriptManifestFileEntry> = {};
  const sourceProjects: Record<string, TranscriptProjectInfo> = {};

  for (const proj of selectedProjects) {
    const count = selectedFiles.filter((f) => f.projectKey === proj.folderName).length;
    if (count > 0) {
      sourceProjects[proj.folderName] = { folderName: proj.folderName, fileCount: count };
    }
  }

  for (const file of selectedFiles) {
    const buf = await fs.readFile(file.absolutePath);
    const content = buf.toString("utf-8");
    const checksum = crypto.createHash("sha256").update(buf).digest("hex");
    const syncKey = transcriptSyncKey(file.projectKey, file.relativePath);
    const gistFileName = syncKeyToGistFileName(syncKey);
    gistFiles[gistFileName] = { content };
    manifestFiles[syncKey] = {
      projectKey: file.projectKey,
      checksum,
      sizeBytes: buf.length,
    };
  }

  const manifest: TranscriptManifest = {
    schemaVersion: 1,
    type: "agent-transcripts",
    createdAt: new Date().toISOString(),
    sourceMachineId: computeMachineId(),
    sourceOS: process.platform,
    sourceProjects,
    files: manifestFiles,
  };

  gistFiles["transcript-manifest.json"] = {
    content: JSON.stringify(manifest, null, 2),
  };

  const client = new GistClient(token);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating public Gist with transcripts...",
      cancellable: false,
    },
    async () => {
      const result = await withRetry(() =>
        client.createGist(gistFiles, "Cursor Sync - Agent Transcripts Export", true)
      );

      if (!result.ok) {
        vscode.window.showErrorMessage(`Transcript export failed: ${result.error.message}`);
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript export failed: ${result.error.category} - ${result.error.message}`
        );
        return;
      }

      const gistUrl = result.data.html_url;
      logger.appendLine(`[${new Date().toISOString()}] Transcript export succeeded: ${gistUrl}`);

      const action = await vscode.window.showInformationMessage(
        `Transcript export successful! Gist: ${gistUrl}`,
        "Copy URL"
      );
      if (action === "Copy URL") {
        await vscode.env.clipboard.writeText(gistUrl);
      }
    }
  );
}

export async function executeImportTranscripts(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Transcript import started`);

  const input = await vscode.window.showInputBox({
    prompt: "Enter the Gist URL or ID containing exported transcripts",
    placeHolder: "e.g., https://gist.github.com/username/abc123 or abc123",
  });

  if (!input) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no input`);
    return;
  }

  const gistId = extractGistId(input);
  if (!gistId) {
    vscode.window.showErrorMessage("Invalid Gist URL or ID.");
    return;
  }

  const token = await getToken(context);
  const client = new GistClient(token);

  const gistResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching transcript Gist...",
      cancellable: false,
    },
    async () => withRetry(() => client.getGist(gistId))
  );

  if (!gistResult.ok) {
    vscode.window.showErrorMessage(`Import failed: ${gistResult.error.message}`);
    return;
  }

  const gistData: GistResponse = gistResult.data;
  const manifestFile = gistData.files["transcript-manifest.json"];
  if (!manifestFile) {
    vscode.window.showErrorMessage(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
    return;
  }

  let manifest: TranscriptManifest;
  try {
    manifest = JSON.parse(manifestFile.content) as TranscriptManifest;
  } catch {
    vscode.window.showErrorMessage("Import failed: invalid transcript-manifest.json.");
    return;
  }

  if (manifest.type !== "agent-transcripts") {
    vscode.window.showErrorMessage("Import failed: Gist does not contain agent transcripts.");
    return;
  }

  const sourceProjectKeys = Object.keys(manifest.sourceProjects);
  if (sourceProjectKeys.length === 0) {
    vscode.window.showInformationMessage("No source projects found in the transcript export.");
    return;
  }

  const localProjects = await discoverProjects();
  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found under ~/.cursor/projects/. " +
        "Open a project in Cursor first to create a project directory."
    );
    return;
  }

  const projectMapping: Map<string, ProjectInfo> = new Map();

  for (const srcKey of sourceProjectKeys) {
    const srcInfo = manifest.sourceProjects[srcKey];
    const srcLabel = humanLabel(srcKey);

    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: p.label,
      description: p.folderName,
      detail: p.fullPath,
    }));

    picks.unshift({ label: "(Skip this project)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${srcLabel}" (${srcInfo.fileCount} file(s)) to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${srcLabel}"`,
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during project mapping`);
      return;
    }

    if (selected.description === "skip") continue;

    const target = localProjects.find((p) => p.folderName === selected.description);
    if (target) {
      projectMapping.set(srcKey, target);
    }
  }

  if (projectMapping.size === 0) {
    vscode.window.showInformationMessage("No projects mapped. Import cancelled.");
    return;
  }

  const filesToWrite: Array<{
    absolutePath: string;
    syncKey: string;
    content: Buffer;
  }> = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === "transcript-manifest.json") continue;

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) continue;

    const srcProjectKey = manifestEntry.projectKey;
    const targetProject = projectMapping.get(srcProjectKey);
    if (!targetProject) continue;

    const relativeInProject = syncKey.slice(
      `transcripts/${srcProjectKey}/`.length
    );
    const targetPath = path.join(
      targetProject.fullPath,
      "agent-transcripts",
      ...relativeInProject.split("/")
    );

    filesToWrite.push({
      absolutePath: targetPath,
      syncKey,
      content: Buffer.from(gistFile.content, "utf-8"),
    });
  }

  if (filesToWrite.length === 0) {
    vscode.window.showInformationMessage("No transcript files to write after mapping.");
    return;
  }

  const fileItems: vscode.QuickPickItem[] = filesToWrite.map((f) => ({
    label: path.basename(f.absolutePath),
    description: f.absolutePath,
    picked: true,
  }));

  const selectedItems = await vscode.window.showQuickPick(fileItems, {
    canPickMany: true,
    title: `Select transcript files to import (${filesToWrite.length} total)`,
    placeHolder: "Deselect files you do not want to import",
  });

  if (!selectedItems || selectedItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no files selected`);
    return;
  }

  const selectedPaths = new Set(selectedItems.map((s) => s.description));
  const finalFiles = filesToWrite.filter((f) => selectedPaths.has(f.absolutePath));

  let writeError = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Writing ${finalFiles.length} transcript file(s)...`,
      cancellable: false,
    },
    async () => {
      for (const file of finalFiles) {
        try {
          const dir = path.dirname(file.absolutePath);
          await fs.mkdir(dir, { recursive: true });
          const tmpPath = file.absolutePath + ".tmp";
          await fs.writeFile(tmpPath, file.content);
          await fs.rename(tmpPath, file.absolutePath);
        } catch (err) {
          logger.appendLine(
            `[${new Date().toISOString()}] Transcript write failed for ${file.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
          );
          writeError = true;
          break;
        }
      }
    }
  );

  if (writeError) {
    vscode.window.showErrorMessage("Transcript import failed: file write error.");
    return;
  }

  const projectSummary = [...projectMapping.entries()]
    .map(([src, target]) => `${humanLabel(src)} -> ${target.label}`)
    .join(", ");

  vscode.window.showInformationMessage(
    `Transcript import complete: ${finalFiles.length} file(s) written. Mappings: ${projectSummary}. ` +
      "Note: Verify that Cursor loads the imported threads by opening the project."
  );
  logger.appendLine(
    `[${new Date().toISOString()}] Transcript import succeeded: ${finalFiles.length} files`
  );
}

function extractGistId(input: string): string | null {
  const match = input.match(
    /(?:gist\.github\.com\/[^/]+\/|)([a-f0-9]{32}|[a-f0-9]{20})/i
  );
  return match ? match[1] : null;
}
