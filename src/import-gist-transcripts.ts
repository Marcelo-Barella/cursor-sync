import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GistClient } from "./gist.js";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import { createBackup, rollbackFromBackup, pruneOldBackups } from "./rollback.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  computeArtifactChecksum,
  decodeTranscriptArtifact,
  encodeTranscriptArtifact,
  gistFileNameToSyncKey,
  syncKeyToGistFileName,
  parseTranscriptBundleManifest,
  summarizeTranscriptForSidebar,
  type TranscriptBundleManifest,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import {
  humanWorkspaceLabel,
  projectQuickPickLabel,
  workspaceQuickPickLabel,
} from "./chat-workspace-label.js";
import { listChatsWorkspaceDirs, type WorkspaceDir } from "./chat-export-ux.js";
import { resolveSyncRoots } from "./paths.js";
import {
  assertCanReadE2eGist,
  GIST_LOCKED_MESSAGE,
  readLogicalFileFromGistMap,
} from "./e2e/gist-read.js";
import { tryReadGistE2eMarker } from "./e2e/gist-bundle.js";

const {
  runSqliteScript,
  resolveStateDbCandidates,
  resolveChatsRoot,
  escapeSqlLiteral,
  mergeComposerHeadersChain,
  mergeComposerDataAdditive,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  stampWorkspaceIdentifierOnPayload,
  isExecFileTimeoutError,
} = __chatPersistenceInternals;

interface DiscoveredTranscript {
  conversationId: string;
  projectKey: string;
  content: string;
  checksum: string;
  sizeBytes: number;
  gistFileName: string;
}

interface ImportFromGistResult {
  transcriptsWritten: number;
  sidebarMerged: boolean;
  conversationIds: string[];
  warnings: string[];
}

/**
 * Main entry point: imports agent transcripts from any GitHub Gist URL or ID.
 */
export async function executeImportTranscriptsFromGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const gistInput = await vscode.window.showInputBox({
    prompt: "Enter Gist URL or ID",
    placeHolder: "https://gist.github.com/user/abc123 or just abc123",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const id = extractGistId(value);
      return id ? null : "Invalid Gist URL or ID";
    },
  });

  if (!gistInput) {
    return;
  }

  const gistId = extractGistId(gistInput);
  if (!gistId) {
    vscode.window.showErrorMessage("Could not extract a valid Gist ID from input.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Importing transcripts from Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await importTranscriptsFromGist(context, gistId, progress);

        const parts: string[] = [
          `Imported ${result.transcriptsWritten} chat session${result.transcriptsWritten === 1 ? "" : "s"}.`,
        ];
        if (result.warnings.length > 0) {
          parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
        }

        vscode.window.showInformationMessage(parts.join(" | "));

        if (result.sidebarMerged) {
          const config = vscode.workspace.getConfiguration("cursorSync");
          const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
          if (autoReload) {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          } else {
            const reloadAction = "Reload Window";
            const choice = await vscode.window.showInformationMessage(
              "Chat sessions have been merged into the sidebar. Reload to see them.",
              reloadAction
            );
            if (choice === reloadAction) {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
        }

        for (const w of result.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [gist-import] ${w}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [gist-import] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Gist import failed: ${msg}`);
      }
    }
  );
}

async function importTranscriptsFromGist(
  context: vscode.ExtensionContext,
  gistId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<ImportFromGistResult> {
  const warnings: string[] = [];

  // Step 1: Fetch Gist
  progress.report({ message: "Fetching Gist..." });
  const token = await getToken(context);
  if (!token) {
    throw new Error("GitHub token not configured. Use 'Cursor Sync: Configure GitHub' to set your token.");
  }
  const gist = await fetchGist(gistId, token);
  if (!gist) {
    throw new Error(`Could not fetch Gist "${gistId}". Check the ID and your GitHub token.`);
  }

  const gistFiles = gist.files ?? {};
  let readGistFile: (logicalFileName: string) => string | undefined;

  if (tryReadGistE2eMarker(gistFiles)) {
    const access = await assertCanReadE2eGist(context, gistFiles);
    if (!access.ok) {
      throw new Error(
        access.message === GIST_LOCKED_MESSAGE ? GIST_LOCKED_MESSAGE : access.message
      );
    }
    readGistFile = (logicalFileName) =>
      readLogicalFileFromGistMap(
        access.dek,
        access.userId,
        access.keyVersion,
        gistFiles,
        logicalFileName
      );
  } else {
    readGistFile = (logicalFileName) => gistFiles[logicalFileName]?.content;
  }

  // Step 2: Parse manifest
  progress.report({ message: "Parsing manifest..." });
  const manifestRaw = readGistFile(TRANSCRIPT_MANIFEST_FILE_NAME);
  if (!manifestRaw) {
    throw new Error("Gist does not contain a transcript manifest. Export transcripts first.");
  }

  let manifest: TranscriptBundleManifest;
  try {
    manifest = parseTranscriptBundleManifest(manifestRaw);
  } catch (err) {
    throw new Error(`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Discover transcripts
  progress.report({ message: "Discovering transcripts..." });
  const transcripts = discoverTranscripts(manifest, readGistFile);
  if (transcripts.length === 0) {
    throw new Error("No transcript files found in Gist.");
  }

  // Step 4: Select target workspace
  progress.report({ message: "Selecting target workspace..." });
  const chatsRoot = resolveChatsRoot();
  const localWorkspaces = await listChatsWorkspaceDirs(chatsRoot);

  let targetWorkspaceKey: string;
  if (localWorkspaces.length === 0) {
    throw new Error(
      "No local chat workspaces found in ~/.cursor/chats/. Open a workspace in Cursor first."
    );
  } else if (localWorkspaces.length === 1) {
    targetWorkspaceKey = localWorkspaces[0]!.name;
  } else {
    const picked = await promptForTargetWorkspace(localWorkspaces);
    if (!picked) {
      return { transcriptsWritten: 0, sidebarMerged: false, conversationIds: [], warnings: ["Cancelled by user."] };
    }
    targetWorkspaceKey = picked;
  }

  // Step 5: Map source projects to target projects
  progress.report({ message: "Mapping projects..." });
  const sourceProjectKeys = [...new Set(transcripts.map((t) => t.projectKey))].sort();
  const projectMapping = await promptForProjectMapping(sourceProjectKeys);
  if (projectMapping === null) {
    return { transcriptsWritten: 0, sidebarMerged: false, conversationIds: [], warnings: ["Cancelled by user."] };
  }

  // Step 6: Write transcript files
  progress.report({ message: "Writing transcript files..." });
  const writtenConversationIds: string[] = [];
  const projectsRoot = resolveProjectsRoot();

  for (const transcript of transcripts) {
    const mappedProjectKey = projectMapping.get(transcript.projectKey) ?? transcript.projectKey;
    const targetPath = path.join(
      projectsRoot,
      mappedProjectKey,
      "agent-transcripts",
      transcript.conversationId,
      `${transcript.conversationId}.jsonl`
    );

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    const { entries: backupEntries } = await createBackup(context, [targetPath]);
    try {
      await fs.writeFile(targetPath, transcript.content, "utf-8");
      writtenConversationIds.push(transcript.conversationId);
    } catch (err) {
      await rollbackFromBackup(backupEntries);
      warnings.push(
        `Failed to write ${transcript.conversationId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Step 7: Build sidebar payloads and merge into state.vscdb
  progress.report({ message: "Merging sidebar state..." });
  const logger = getLogger();

  const stateDbPaths = await resolveStateDbCandidates();

  let sidebarMerged = false;
  if (stateDbPaths.length === 0) {
    warnings.push("state.vscdb not found; sidebar merge skipped.");
  } else {
    const dbPath = stateDbPaths[0]!;

    try {
      const headersPayloads = buildHeadersPayloads(transcripts, projectMapping, logger);

      if (headersPayloads.length > 0) {
        const rows = await readExistingComposerState(dbPath, logger);
        const existingHeadersRaw = rows.headersRaw;

        const scriptParts: string[] = ["BEGIN IMMEDIATE;"];

        const merged = mergeComposerHeadersChain(existingHeadersRaw, headersPayloads);

        const escaped = escapeSqlLiteral(JSON.stringify(merged));
        scriptParts.push(
          `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'composer.composerHeaders';`,
          `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escaped}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`
        );

        scriptParts.push("COMMIT;");

        const { entries: backupEntries } = await createBackup(context, [dbPath]);
        try {
          await runSqliteScript(dbPath, scriptParts.join("\n") + "\n");
          sidebarMerged = true;
          logger.appendLine(`[${new Date().toISOString()}] [gist-import] Sidebar merged successfully for ${headersPayloads.length} chat(s).`);
        } catch (err) {
          await rollbackFromBackup(backupEntries);
          const errMsg = err instanceof Error ? err.message : String(err);
          warnings.push(
            `state.vscdb write failed: ${errMsg}; rolled back.`
          );
        }
      } else {
        warnings.push("No sidebar payloads generated; merge skipped.");
      }
    } catch (err) {
      const isTimeout = isExecFileTimeoutError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      warnings.push(
        isTimeout
          ? "state.vscdb timed out (database may be locked); sidebar merge skipped."
          : `state.vscdb read failed: ${errMsg}`
      );
    }
  }

  await pruneOldBackups(context);

  return {
    transcriptsWritten: writtenConversationIds.length,
    sidebarMerged,
    conversationIds: writtenConversationIds,
    warnings,
  };
}

// --- Gist Fetching ---

async function fetchGist(
  gistId: string,
  token: string | undefined
): Promise<{ files?: Record<string, { content?: string }> } | null> {
  // If a token is available, pass it to the client to ensure authenticated requests.
  // Do not pass an undefined token to the constructor when no token exists.
  const gistClient = token ? new GistClient(token) : new GistClient();
  const result = await gistClient.getGist(gistId);
  if (!result.ok) {
    // Provide actionable, user-friendly messages based on the API error.
    const status = result.error?.statusCode ?? undefined;
    const category = result.error?.category;

    if (status === 404) {
      throw new Error(
        `Gist not found. If it's private, make sure your GitHub token is configured (Cursor Sync: Configure GitHub).`
      );
    }
    if (status === 401 || status === 403 || category === "AUTH_FAILED") {
      throw new Error("Authentication failed. Check your GitHub token has Gist read access.");
    }
    if (result.error?.category === "NETWORK_ERROR") {
      throw new Error(result.error?.message ?? `Network error while fetching Gist`);
    }
    // Fallback generic error
    throw new Error(result.error?.message ?? `Failed to fetch Gist: ${status ?? 0}`);
  }
  return result.data as { files?: Record<string, { content?: string }> };
}

function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL: https://gist.github.com/user/abc123
  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1]!;

  // Just an ID (alphanumeric + hyphens)
  if (/^[A-Za-z0-9-]+$/.test(trimmed)) return trimmed;

  return null;
}

// --- Transcript Discovery ---

function discoverTranscripts(
  manifest: TranscriptBundleManifest,
  readGistFile: (logicalFileName: string) => string | undefined
): DiscoveredTranscript[] {
  const transcripts: DiscoveredTranscript[] = [];

  if (manifest.schemaVersion === 1) {
    const v1 = manifest as TranscriptManifestV1;
    for (const [gistFileName, entry] of Object.entries(v1.files)) {
      if (!gistFileName.endsWith(".jsonl")) continue;

      const content = readGistFile(gistFileName);
      if (!content) continue;

      const syncKey = gistFileNameToSyncKey(gistFileName);
      // Format: transcripts/<projectKey>/<conversationId>/<conversationId>.jsonl
      const parts = syncKey.split("/");
      if (parts.length < 3) continue;

      const projectKey = parts[1]!;
      const conversationId = parts[2]!;

      const buf = Buffer.from(content, "utf-8");
      const checksum = computeArtifactChecksum(buf);

      transcripts.push({
        conversationId,
        projectKey,
        content,
        checksum,
        sizeBytes: buf.length,
        gistFileName,
      });
    }
  } else if (manifest.schemaVersion === 2) {
    const v2 = manifest as TranscriptManifestV2;
    for (const [artifactKey, artifact] of Object.entries(v2.artifacts)) {
      if (artifact.kind !== "transcript") continue;

      const gistFileName = syncKeyToGistFileName(artifactKey);
      const content = readGistFile(gistFileName);
      if (!content) continue;

      const buf = Buffer.from(content, "utf-8");
      const checksum = computeArtifactChecksum(buf);

      transcripts.push({
        conversationId: artifact.conversationId,
        projectKey: artifact.projectKey,
        content,
        checksum,
        sizeBytes: buf.length,
        gistFileName,
      });
    }
  }

  return transcripts;
}

// --- Sidebar Payload Building ---

function buildHeadersPayloads(
  transcripts: DiscoveredTranscript[],
  projectMapping: Map<string, string>,
  logger?: ReturnType<typeof getLogger>
): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];

  for (const transcript of transcripts) {
    const summary = summarizeTranscriptForSidebar(transcript.content, transcript.conversationId);

    let payload = deriveComposerHeadersPayloadFromSidebarSnapshot({
      conversationId: transcript.conversationId,
      title: summary.title,
      subtitle: summary.subtitle,
      lastUpdatedAt: summary.lastUpdatedAt ?? new Date().toISOString(),
    });

    if (payload) {
      // Use stampWorkspaceIdentifierOnPayload which reads the real workspace folder
      // from vscode.workspace.workspaceFolders and stamps a matching workspaceIdentifier.
      // This ensures imported chats appear in the sidebar for the currently open workspace.
      const stamped = stampWorkspaceIdentifierOnPayload(payload);
      payloads.push(stamped);
    } else {
      logger?.appendLine(`[gist-import] WARNING: deriveComposerHeadersPayload returned undefined for: ${transcript.conversationId}`);
    }
  }

  return payloads;
}

// --- SQLite Helpers ---

async function readExistingComposerState(
  dbPath: string,
  logger?: ReturnType<typeof getLogger>
): Promise<{ headersRaw: string | undefined; dataRaw: string | undefined }> {
  const { querySqliteRows } = __chatPersistenceInternals;
  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
    { retries: 3 }
  );

  let headersRaw: string | undefined;
  let dataRaw: string | undefined;

  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    if (key === "composer.composerHeaders") {
      headersRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
    if (key === "composer.composerData") {
      dataRaw = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  return { headersRaw, dataRaw };
}

// --- Workspace & Project Selection ---

async function promptForTargetWorkspace(
  localWorkspaces: WorkspaceDir[]
): Promise<string | null> {
  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const picks: vscode.QuickPickItem[] = localWorkspaces.map((w) => {
    const row = workspaceQuickPickLabel(w.name, folderMap);
    return { label: row.label, description: row.description, detail: w.fullPath };
  });

  const selected = await vscode.window.showQuickPick(picks, {
    title: "Select target workspace for imported chats",
    placeHolder: "Choose the workspace where chat sessions will appear",
  });

  return selected?.description ?? null;
}

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

async function promptForProjectMapping(
  sourceProjectKeys: string[]
): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first."
    );
    return null;
  }

  const { cursorUser } = resolveSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: projectQuickPickLabel(p.name, folderMap),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Keep original)", description: sourceKey });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}

export const __importGistTranscriptsTestUtils = {
  promptForTargetWorkspace,
  promptForProjectMapping,
};
