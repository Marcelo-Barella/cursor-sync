import * as vscode from "vscode";
import { USER_LABEL_DOT_CURSOR, USER_LABEL_DOT_CURSOR_CHATS, USER_LABEL_DOT_CURSOR_PROJECTS, USER_LABEL_HOME_TILDE_PREFIX } from "./paths.js";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import { GistClient } from "./gist.js";
import { withRetry } from "./retry.js";
import type { GistResponse } from "./types.js";
import {
  TRANSCRIPT_MANIFEST_FILE_NAME,
  computeArtifactChecksum,
  decodeTranscriptArtifact,
  gistFileNameToSyncKey,
  getConversationIdFromRelativePath,
  isTranscriptManifestV2,
  parseTranscriptBundleManifest,
  syncKeyToGistFileName,
  type TranscriptManifestV1,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import {
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
  buildFallbackProjectMapping,
  humanLabel,
  type ProjectInfo,
} from "./transcripts-discovery.js";
import {
  augmentV1ImportOperations,
  collectRequiredStoreWorkspaceKeys,
  deriveStoreWorkspaceMapping,
  listChatsWorkspaceKeys,
  preflightV2ConversationImport,
  previewAndApplyImportPlan,
  promptForProjectMapping,
  promptForWorkspaceMapping,
} from "./transcripts-import-plan.js";
import { extractGistId } from "./transcripts-export.js";
import type { RestoreOperation } from "./transcripts-internal-types.js";
import { resolveArtifactImportPath } from "./transcripts-import-sidebar.js";

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
  const manifestFile = gistData.files[TRANSCRIPT_MANIFEST_FILE_NAME];
  if (!manifestFile) {
    vscode.window.showErrorMessage(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
    return;
  }

  let manifest: TranscriptManifestV1 | TranscriptManifestV2;
  try {
    manifest = parseTranscriptBundleManifest(manifestFile.content);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Import failed: ${error instanceof Error ? error.message : "invalid transcript-manifest.json."}`
    );
    return;
  }

  const localProjects = await discoverProjects();
  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      `No local Cursor projects found under ${USER_LABEL_DOT_CURSOR}/projects/. ` +
        "Open a project in Cursor first to create a project directory."
    );
    return;
  }

  let projectMapping = await promptForProjectMapping(
    Object.keys(manifest.sourceProjects),
    Object.fromEntries(
      Object.entries(manifest.sourceProjects).map(([projectKey, info]) => [
        projectKey,
        { fileCount: info.fileCount },
      ])
    ),
    localProjects,
    logger
  );

  if (projectMapping === null) {
    return;
  }

  if (projectMapping.size === 0) {
    const cfg = vscode.workspace.getConfiguration("cursorSync");
    const allowFallback =
      cfg.get<boolean>("transcripts.importFallbackToCurrentWorkspace") ?? true;
    if (!allowFallback) {
      vscode.window.showInformationMessage("No projects mapped. Import cancelled.");
      return;
    }
    const target = findProjectMatchingOpenWorkspaceFolder(localProjects);
    if (!target) {
      vscode.window.showErrorMessage(
        `No projects mapped. Open the correct repo folder in Cursor (File > Open Folder) so a ${USER_LABEL_DOT_CURSOR}/projects/ entry matches this workspace, or map projects manually when prompted.`
      );
      return;
    }
    const sourceKeys = Object.keys(manifest.sourceProjects).sort();
    const confirm = await vscode.window.showWarningMessage(
      `Map all ${sourceKeys.length} source project(s) from this Gist to this workspace’s Cursor project "${target.label}"?`,
      { modal: true },
      "Map all here",
      "Cancel"
    );
    if (confirm !== "Map all here") {
      vscode.window.showInformationMessage("Import cancelled.");
      return;
    }
    projectMapping = buildFallbackProjectMapping(sourceKeys, target);
  }

  if (isTranscriptManifestV2(manifest)) {
    await importTranscriptBundleV2(context, gistData, manifest, projectMapping, logger);
    return;
  }

  await importTranscriptBundleV1(context, gistData, manifest, projectMapping, logger);
}

async function importTranscriptBundleV1(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV1,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const operations: RestoreOperation[] = [];

  for (const [gistFileName, gistFile] of Object.entries(gistData.files)) {
    if (gistFileName === TRANSCRIPT_MANIFEST_FILE_NAME) {
      continue;
    }

    const syncKey = gistFileNameToSyncKey(gistFileName);
    const manifestEntry = manifest.files[syncKey];
    if (!manifestEntry) {
      continue;
    }

    const targetProject = projectMapping.get(manifestEntry.projectKey);
    if (!targetProject) {
      continue;
    }

    const relativeInProject = syncKey.slice(`transcripts/${manifestEntry.projectKey}/`.length);
    const content = Buffer.from(gistFile.content, "utf-8");
    const checksum = computeArtifactChecksum(content);
    if (checksum !== manifestEntry.checksum) {
      vscode.window.showErrorMessage(
        `Import failed: checksum mismatch for ${relativeInProject}.`
      );
      return;
    }

    operations.push({
      absolutePath: path.join(
        targetProject.fullPath,
        "agent-transcripts",
        ...relativeInProject.split("/")
      ),
      content,
      checksum,
      syncKey,
      kind: "transcript",
      conversationId: getConversationIdFromRelativePath(relativeInProject),
    });
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No transcript files to write after mapping.");
    return;
  }

  const fileItems: vscode.QuickPickItem[] = operations.map((operation) => ({
    label: path.basename(operation.absolutePath),
    description: operation.absolutePath,
    picked: true,
  }));

  const selectedItems = await vscode.window.showQuickPick(fileItems, {
    canPickMany: true,
    title: `Select transcript files to import (${operations.length} total)`,
    placeHolder: "Deselect files you do not want to import",
  });

  if (!selectedItems || selectedItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled: no files selected`);
    return;
  }

  const selectedPaths = new Set(selectedItems.map((item) => item.description));
  const selectedOperations = operations.filter((operation) =>
    selectedPaths.has(operation.absolutePath)
  );

  const augmented = await augmentV1ImportOperations(
    gistData,
    selectedOperations,
    projectMapping,
    logger
  );

  await previewAndApplyImportPlan(context, augmented, "Import transcript files", logger, {
    importRestoreReport: true,
  });
}

async function importTranscriptBundleV2(
  context: vscode.ExtensionContext,
  gistData: GistResponse,
  manifest: TranscriptManifestV2,
  projectMapping: Map<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const availableConversations = Object.entries(manifest.conversations)
    .filter(([, conversation]) => projectMapping.has(conversation.projectKey))
    .sort(([a], [b]) => a.localeCompare(b));

  if (availableConversations.length === 0) {
    vscode.window.showInformationMessage("No conversations remain after project mapping.");
    return;
  }

  const conversationItems: Array<vscode.QuickPickItem & { conversationKey: string }> =
    availableConversations.map(([conversationKey, conversation]) => ({
      conversationKey,
      label: conversation.title,
      description: `${humanLabel(conversation.projectKey)} · ${conversation.conversationId}`,
      detail: [
        conversation.subtitle,
        conversation.storeArtifact ? "store snapshot included" : "store snapshot missing",
        "sidebar sidecar + state.vscdb merge when snapshot allows",
      ].join(" · "),
      picked: true,
    }));

  const selectedConversations = await vscode.window.showQuickPick(conversationItems, {
    canPickMany: true,
    title: `Select conversations to import (${conversationItems.length} available)`,
    placeHolder: "Deselect conversations you do not want to restore",
  });

  if (!selectedConversations || selectedConversations.length === 0) {
    logger.appendLine(
      `[${new Date().toISOString()}] Transcript import cancelled: no conversations selected`
    );
    return;
  }

  const selectedConversationKeys = new Set(
    selectedConversations.map((conversation) => conversation.conversationKey)
  );

  const chatsWorkspaceKeys = await listChatsWorkspaceKeys();
  const { resolved: derivedWorkspace, ambiguousSources } = deriveStoreWorkspaceMapping(
    manifest,
    selectedConversationKeys,
    projectMapping
  );
  let workspaceMapping = new Map<string, string>(derivedWorkspace);
  const requiredStoreWorkspaceKeys = collectRequiredStoreWorkspaceKeys(
    manifest,
    selectedConversationKeys
  );
  const promptWorkspaceSources = new Set<string>(ambiguousSources);
  for (const swk of requiredStoreWorkspaceKeys) {
    if (chatsWorkspaceKeys.length > 0 && !chatsWorkspaceKeys.includes(swk)) {
      promptWorkspaceSources.add(swk);
    }
  }
  if (promptWorkspaceSources.size > 0) {
    for (const swk of promptWorkspaceSources) {
      workspaceMapping.delete(swk);
    }
    const prompted = await promptForWorkspaceMapping(
      [...promptWorkspaceSources].sort(),
      chatsWorkspaceKeys,
      logger
    );
    if (prompted === null) {
      return;
    }
    for (const [k, v] of prompted) {
      workspaceMapping.set(k, v);
    }
  }

  const preflightErrors: string[] = [];
  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) continue;
    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) continue;
    preflightErrors.push(
      ...(await preflightV2ConversationImport({
        gistData,
        manifest,
        conversation,
        targetProject,
        workspaceMapping,
      }))
    );
  }

  if (preflightErrors.length > 0) {
    vscode.window.showErrorMessage(preflightErrors[0]!);
    return;
  }

  const operations: RestoreOperation[] = [];
  const stagedWarnings = new Set<string>();

  for (const [conversationKey, conversation] of availableConversations) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }

    const targetProject = projectMapping.get(conversation.projectKey);
    if (!targetProject) {
      continue;
    }

    const artifactIds = [
      ...conversation.transcriptArtifacts,
      conversation.sidebarArtifact,
      ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
    ];

    for (const artifactId of artifactIds) {
      const artifactEntry = manifest.artifacts[artifactId];
      if (!artifactEntry) {
        continue;
      }

      const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
      if (!gistFile) {
        continue;
      }

      const content = decodeTranscriptArtifact(gistFile.content, artifactEntry.encoding);

      operations.push({
        absolutePath: resolveArtifactImportPath(targetProject, artifactEntry, workspaceMapping),
        content,
        checksum: artifactEntry.checksum,
        syncKey: artifactId,
        kind: artifactEntry.kind,
        conversationId: artifactEntry.conversationId,
      });
    }

    for (const warning of conversation.warnings) {
      stagedWarnings.add(`${conversation.conversationId}: ${warning}`);
    }
  }

  if (operations.length === 0) {
    vscode.window.showInformationMessage("No bundle artifacts to restore after selection.");
    return;
  }

  await previewAndApplyImportPlan(context, operations, "Import conversation bundle", logger, {
    importRestoreReport: true,
    warnings: [...stagedWarnings].sort(),
  });
}
