import * as vscode from "vscode";
import { USER_LABEL_DOT_CURSOR, USER_LABEL_DOT_CURSOR_CHATS, USER_LABEL_DOT_CURSOR_PROJECTS, USER_LABEL_HOME_TILDE_PREFIX } from "./paths.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import type { GistResponse } from "./types.js";
import {
  bundleArtifactSyncKey,
  computeArtifactChecksum,
  decodeTranscriptArtifact,
  syncKeyToGistFileName,
  type TranscriptBundleConversationEntry,
  type TranscriptManifestV2,
} from "./transcript-bundle.js";
import { accessPathOutcome } from "./transcripts-sqlite.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type {
  DelayedWritebackHandle,
  ExportConversationState,
  RestoreOperation,
  RestorePreview,
} from "./transcripts-internal-types.js";
import type { ProjectInfo } from "./transcripts-discovery.js";
import { humanLabel } from "./transcripts-discovery.js";
import {
  applySidebarStateRestoration,
  buildSidebarMetadataSnapshot,
} from "./transcripts-import-sidebar.js";

export async function promptForProjectMapping(
  sourceProjectKeys: string[],
  sourceProjects: Record<string, { fileCount: number }>,
  localProjects: ProjectInfo[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, ProjectInfo> | null> {
  if (sourceProjectKeys.length === 0) {
    vscode.window.showInformationMessage("No source projects found in the transcript export.");
    return new Map();
  }

  const projectMapping: Map<string, ProjectInfo> = new Map();

  for (const sourceProjectKey of sourceProjectKeys.sort()) {
    const sourceInfo = sourceProjects[sourceProjectKey];
    const sourceLabel = humanLabel(sourceProjectKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((project) => ({
      label: project.label,
      description: project.folderName,
      detail: project.fullPath,
    }));

    picks.unshift({ label: "(Skip this project)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" (${sourceInfo.fileCount} file(s)) to a local project`,
      placeHolder: `Select the local project to receive transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during project mapping`);
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    const targetProject = localProjects.find(
      (project) => project.folderName === selected.description
    );
    if (targetProject) {
      projectMapping.set(sourceProjectKey, targetProject);
    }
  }

  return projectMapping;
}

export async function previewAndApplyImportPlan(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  actionLabel: string,
  logger: ReturnType<typeof getLogger>,
  options: {
    importRestoreReport: boolean;
    warnings?: string[];
  }
): Promise<void> {
  const preview = await previewRestoreOperations(operations);

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0 && preview.unchanged.length === 0) {
    vscode.window.showInformationMessage(
      `${actionLabel} skipped: no artifacts selected.`
    );
    return;
  }

  if (preview.newFiles.length === 0 && preview.conflicts.length === 0) {
    const sidebarOps = preview.unchanged.filter((op) => op.kind === "sidebar");
    if (options.importRestoreReport && sidebarOps.length > 0) {
      try {
        const stateOutcome = await applySidebarStateRestoration(context, sidebarOps, logger, {
          scheduleDelayedWriteback: true,
        });
        const sidebarMerged = stateOutcome.stateDbMerged > 0;

        vscode.window.showInformationMessage(
          `Transcript import: ${preview.unchanged.length} unchanged${sidebarMerged ? ", sidebar updated" : ""}.`
        );

        if (sidebarMerged) {
          const config = vscode.workspace.getConfiguration("cursorSync");
          const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
          if (autoReload) {
            await stateOutcome.delayedWriteback?.complete();
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
          } else {
            const reloadAction = "Reload Window";
            const selected = await vscode.window.showInformationMessage(
              "Sidebar updated. Reload Cursor to see imported conversations.",
              reloadAction
            );
            if (selected === reloadAction) {
              await stateOutcome.delayedWriteback?.complete();
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          }
        }
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files): sidebarMerged=${stateOutcome.stateDbMerged} skippedPayload=${stateOutcome.stateDbSkippedNoPayload} skippedDb=${stateOutcome.stateDbSkippedNoDb} delayedWriteback=${stateOutcome.delayedWriteback ? "scheduled" : "none"}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Transcript import: sidebar state merge failed: ${msg}`
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Transcript import (unchanged files) state merge error: ${msg}`
        );
      }
      return;
    }
  }

  const summary = [
    `${operations.length} artifact(s) selected`,
    `${preview.newFiles.length} new`,
    `${preview.conflicts.length} conflict${preview.conflicts.length === 1 ? "" : "s"}`,
    `${preview.unchanged.length} unchanged`,
  ].join(", ");

  let conflictPolicy: "overwrite" | "skip" = "overwrite";
  if (preview.conflicts.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${actionLabel}: ${summary}. Choose how to handle conflicts.`,
      { modal: true },
      "Overwrite Conflicts",
      "Skip Conflicts",
      "Cancel"
    );

    if (choice === "Cancel" || !choice) {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during conflict review`);
      return;
    }

    conflictPolicy = choice === "Skip Conflicts" ? "skip" : "overwrite";
  } else {
    const choice = await vscode.window.showInformationMessage(
      `${actionLabel}: ${summary}. Use the Import action to write files and update sidebar state.`,
      { modal: true },
      "Import",
      "Cancel"
    );

    if (choice !== "Import") {
      logger.appendLine(`[${new Date().toISOString()}] Transcript import cancelled during preview confirmation`);
      return;
    }
  }

  const toWrite = [
    ...preview.newFiles,
    ...(conflictPolicy === "overwrite" ? preview.conflicts : []),
  ].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));

  const allSidebarOps = [
    ...preview.newFiles,
    ...(conflictPolicy === "overwrite" ? preview.conflicts : []),
    ...preview.unchanged,
  ].filter((op) => op.kind === "sidebar");

  if (toWrite.length === 0 && allSidebarOps.length === 0) {
    vscode.window.showInformationMessage(
      `${actionLabel}: everything already up to date.`
    );
    return;
  }

  let writtenCount = 0;
  if (toWrite.length > 0) {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Writing ${toWrite.length} transcript artifact(s)...`,
        cancellable: false,
      },
      async () => applyRestoreOperations(context, toWrite, logger)
    );

    if (!result.ok) {
      vscode.window.showErrorMessage(result.message);
      return;
    }
    writtenCount = result.writtenCount;
  }

  let sidebarMerged = false;
  let delayedWritebackHandle: DelayedWritebackHandle | undefined;
  if (options.importRestoreReport && allSidebarOps.length > 0) {
    try {
      const stateOutcome = await applySidebarStateRestoration(context, allSidebarOps, logger, {
        scheduleDelayedWriteback: true,
      });
      sidebarMerged = stateOutcome.stateDbMerged > 0;
      delayedWritebackHandle = stateOutcome.delayedWriteback;
      if (stateOutcome.warnings.length > 0) {
        for (const w of stateOutcome.warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [import] ${w}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.appendLine(`[${new Date().toISOString()}] [import] sidebar state merge failed: ${msg}`);
    }
  }

  const parts: string[] = [];
  if (writtenCount > 0) parts.push(`${writtenCount} written`);
  if (preview.unchanged.length > 0) parts.push(`${preview.unchanged.length} unchanged`);
  const skipped = conflictPolicy === "skip" ? preview.conflicts.length : 0;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (sidebarMerged) parts.push("sidebar updated");

  const warningParts = [...(options.warnings ?? [])];
  const warningSuffix =
    warningParts.length > 0 ? ` (${warningParts.length} warning${warningParts.length === 1 ? "" : "s"})` : "";

  vscode.window.showInformationMessage(
    `Transcript import complete: ${parts.join(", ")}.${warningSuffix}`
  );

  if (sidebarMerged) {
    const config = vscode.workspace.getConfiguration("cursorSync");
    const autoReload = config.get<boolean>("transcripts.autoReloadAfterImport") ?? false;
    if (autoReload) {
      await delayedWritebackHandle?.complete();
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else {
      const reloadAction = "Reload Window";
      const selected = await vscode.window.showInformationMessage(
        "Sidebar updated. Reload Cursor to see imported conversations.",
        reloadAction
      );
      if (selected === reloadAction) {
        await delayedWritebackHandle?.complete();
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    }
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Transcript import succeeded: ${writtenCount} written, ${preview.unchanged.length} unchanged, sidebarMerged=${sidebarMerged} delayedWriteback=${delayedWritebackHandle ? "scheduled" : "none"}`
  );
}

export async function previewRestoreOperations(
  operations: RestoreOperation[]
): Promise<RestorePreview> {
  const preview: RestorePreview = {
    newFiles: [],
    conflicts: [],
    unchanged: [],
  };

  for (const operation of operations) {
    try {
      const existing = await fs.readFile(operation.absolutePath);
      const existingChecksum = computeArtifactChecksum(existing);
      if (existingChecksum === operation.checksum) {
        preview.unchanged.push(operation);
      } else {
        preview.conflicts.push(operation);
      }
    } catch {
      preview.newFiles.push(operation);
    }
  }

  return preview;
}

export async function applyRestoreOperations(
  context: vscode.ExtensionContext,
  operations: RestoreOperation[],
  logger: ReturnType<typeof getLogger>
): Promise<
  | { ok: true; writtenCount: number }
  | { ok: false; message: string }
> {
  const existingPaths: string[] = [];
  const createdPaths: string[] = [];

  for (const operation of operations) {
    const outcome = await accessPathOutcome(operation.absolutePath);
    if (outcome === "timeout") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import: access timed out for ${operation.absolutePath}`
      );
      return {
        ok: false,
        message:
          "Transcript import failed: a destination path did not respond in time (slow disk, network folder, or permission issue).",
      };
    }
    if (outcome === "exists") {
      existingPaths.push(operation.absolutePath);
    } else {
      createdPaths.push(operation.absolutePath);
    }
  }

  const { entries: backupEntries } = await createBackup(context, existingPaths);

  let writtenCount = 0;

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i]!;
    try {
      await fs.mkdir(path.dirname(operation.absolutePath), { recursive: true });
      const tmpPath = `${operation.absolutePath}.tmp`;
      await fs.writeFile(tmpPath, operation.content);
      await fs.rename(tmpPath, operation.absolutePath);
      writtenCount += 1;
    } catch (error) {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript write failed for ${operation.absolutePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      await rollbackFromBackup(backupEntries);
      await Promise.all(
        createdPaths.map((createdPath) => fs.rm(createdPath, { force: true }).catch(() => undefined))
      );
      return {
        ok: false,
        message: "Transcript import failed: file write error. Existing files were rolled back.",
      };
    }
  }

  await pruneOldBackups(context);

  return { ok: true, writtenCount };
}

function getSourceProjectKeyFromTranscriptSyncKey(syncKey: string): string | undefined {
  const prefix = "transcripts/";
  if (!syncKey.startsWith(prefix)) {
    return undefined;
  }
  const rest = syncKey.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return slash === -1 && rest.length > 0 ? rest : undefined;
  }
  return rest.slice(0, slash);
}

function decodeTolerantStoreGistContent(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Buffer.alloc(0);
  }
  const noWs = trimmed.replace(/\s/g, "");
  try {
    const asB64 = Buffer.from(noWs, "base64");
    if (asB64.length >= 16 && asB64.subarray(0, 15).toString("latin1") === "SQLite format 3") {
      return asB64;
    }
    if (noWs.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(noWs) && noWs.length % 4 === 0) {
      return asB64;
    }
  } catch {
  }
  return decodeTranscriptArtifact(trimmed, undefined);
}

async function resolveV1ImportStoreChatsWorkspaceKey(defaultKey: string): Promise<string> {
  const keys = await listChatsWorkspaceKeys();
  if (keys.length === 0) {
    return defaultKey;
  }
  if (keys.length === 1) {
    return keys[0]!;
  }
  const picks: vscode.QuickPickItem[] = keys.map((k) => ({ label: k, description: k }));
  picks.unshift({ label: `Use default (${defaultKey})`, description: defaultKey });
  picks.push({ label: "Enter custom workspace key…", description: "__custom__" });
  const selected = await vscode.window.showQuickPick(picks, {
    title: `Legacy bundle: restore store.db under which ${USER_LABEL_DOT_CURSOR}/chats key?`,
    placeHolder: "Chats workspace hash is not the Cursor project folder name",
  });
  if (!selected?.description) {
    return defaultKey;
  }
  if (selected.description === "__custom__") {
    const raw = await vscode.window.showInputBox({
      prompt: `Target directory name under ${USER_LABEL_DOT_CURSOR}/chats/`,
      validateInput: (v) => {
        if (!v || !isSafeWorkspaceKeySegment(v.trim())) {
          return "Use one non-empty path segment without slashes.";
        }
        return undefined;
      },
    });
    if (raw === undefined) {
      return defaultKey;
    }
    return raw.trim();
  }
  return selected.description;
}

export async function augmentV1ImportOperations(
  gistData: GistResponse,
  transcriptOperations: RestoreOperation[],
  projectMapping: ReadonlyMap<string, ProjectInfo>,
  logger: ReturnType<typeof getLogger>
): Promise<RestoreOperation[]> {
  const extra: RestoreOperation[] = [];
  const seenStores = new Set<string>();
  const seenSidebars = new Set<string>();

  const groups = new Map<
    string,
    {
      sourceProjectKey: string;
      conversationId: string;
      targetProject: ProjectInfo;
      ops: RestoreOperation[];
    }
  >();

  for (const op of transcriptOperations) {
    const sourcePk = getSourceProjectKeyFromTranscriptSyncKey(op.syncKey);
    if (!sourcePk || !op.conversationId) {
      continue;
    }
    const targetProject = projectMapping.get(sourcePk);
    if (!targetProject) {
      continue;
    }
    const gkey = `${sourcePk}:${op.conversationId}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { sourceProjectKey: sourcePk, conversationId: op.conversationId, targetProject, ops: [] };
      groups.set(gkey, g);
    }
    g.ops.push(op);
  }

  const createdAt = new Date().toISOString();
  const sortedGroups = [...groups.values()].sort((a, b) =>
    a.sourceProjectKey !== b.sourceProjectKey
      ? a.sourceProjectKey.localeCompare(b.sourceProjectKey)
      : a.conversationId.localeCompare(b.conversationId)
  );

  const needsV1Store = sortedGroups.some((g) => {
    const sk = bundleArtifactSyncKey(g.sourceProjectKey, g.conversationId, "store", "store.db");
    return Boolean(gistData.files[syncKeyToGistFileName(sk)]);
  });
  const v1StoreChatsKey = needsV1Store
    ? await resolveV1ImportStoreChatsWorkspaceKey(sortedGroups[0]!.targetProject.folderName)
    : "";

  for (const g of sortedGroups) {
    const storeSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "store",
      "store.db"
    );
    const sidebarSyncKey = bundleArtifactSyncKey(
      g.sourceProjectKey,
      g.conversationId,
      "sidebar",
      "sidebar-metadata.json"
    );

    const storeGist = gistData.files[syncKeyToGistFileName(storeSyncKey)];
    if (storeGist && !seenStores.has(storeSyncKey)) {
      seenStores.add(storeSyncKey);
      const storeBuf = decodeTolerantStoreGistContent(storeGist.content);
      if (storeBuf.length > 0) {
        extra.push({
          absolutePath: path.join(
            resolveChatsRoot(),
            v1StoreChatsKey,
            g.conversationId,
            "store.db"
          ),
          content: storeBuf,
          checksum: computeArtifactChecksum(storeBuf),
          syncKey: storeSyncKey,
          kind: "store",
          conversationId: g.conversationId,
        });
      } else {
        logger.appendLine(
          `[${new Date().toISOString()}] V1 import skipped empty store artifact for ${storeSyncKey}`
        );
      }
    }

    if (seenSidebars.has(sidebarSyncKey)) {
      continue;
    }
    seenSidebars.add(sidebarSyncKey);

    const sidebarGist = gistData.files[syncKeyToGistFileName(sidebarSyncKey)];
    let sidebarBuffer: Buffer;
    if (sidebarGist) {
      sidebarBuffer = Buffer.from(sidebarGist.content, "utf-8");
    } else {
      const transcriptRelativePaths = [
        ...new Set(
          g.ops.map((op) => op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length))
        ),
      ].sort();
      let primaryContent = g.ops[0]!.content.toString("utf-8");
      let primaryAt = transcriptRelativePaths[0] ?? "";
      for (const op of g.ops) {
        const rel = op.syncKey.slice(`transcripts/${g.sourceProjectKey}/`.length);
        if (path.basename(rel, path.extname(rel)) === g.conversationId) {
          primaryContent = op.content.toString("utf-8");
          primaryAt = rel;
          break;
        }
      }
      const synthetic: ExportConversationState = {
        projectKey: g.sourceProjectKey,
        conversationId: g.conversationId,
        transcriptArtifacts: [],
        transcriptRelativePaths,
        primaryTranscriptContent: primaryContent,
        primaryTranscriptSelectedAt: primaryAt,
        lastUpdatedAt: createdAt,
        warnings: [],
      };
      const snapshot = await buildSidebarMetadataSnapshot(synthetic, createdAt);
      sidebarBuffer = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
    }

    extra.push({
      absolutePath: path.join(
        g.targetProject.fullPath,
        "agent-transcripts",
        g.conversationId,
        "cursor-sidebar-metadata.json"
      ),
      content: sidebarBuffer,
      checksum: computeArtifactChecksum(sidebarBuffer),
      syncKey: sidebarSyncKey,
      kind: "sidebar",
      conversationId: g.conversationId,
    });
  }

  return [...transcriptOperations, ...extra].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
}

export function collectRequiredStoreWorkspaceKeys(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>
): string[] {
  const keys = new Set<string>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk === "string" && swk.length > 0) {
      keys.add(swk);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export function deriveStoreWorkspaceMapping(
  manifest: TranscriptManifestV2,
  selectedConversationKeys: Set<string>,
  projectMapping: ReadonlyMap<string, ProjectInfo>
): { resolved: Map<string, string>; ambiguousSources: string[] } {
  const targetsBySource = new Map<string, Set<string>>();
  for (const [conversationKey, conv] of Object.entries(manifest.conversations)) {
    if (!selectedConversationKeys.has(conversationKey)) {
      continue;
    }
    if (!conv.storeArtifact) {
      continue;
    }
    const storeEntry = manifest.artifacts[conv.storeArtifact];
    const swk = storeEntry?.sourceWorkspaceKey;
    if (typeof swk !== "string" || swk.length === 0) {
      continue;
    }
    const tp = projectMapping.get(conv.projectKey);
    if (!tp) {
      continue;
    }
    const set = targetsBySource.get(swk) ?? new Set<string>();
    set.add(tp.folderName);
    targetsBySource.set(swk, set);
  }
  const resolved = new Map<string, string>();
  const ambiguousSources: string[] = [];
  for (const [swk, set] of [...targetsBySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (set.size === 1) {
      resolved.set(swk, [...set][0]!);
    } else {
      ambiguousSources.push(swk);
    }
  }
  return { resolved, ambiguousSources };
}

export async function listChatsWorkspaceKeys(): Promise<string[]> {
  const root = resolveChatsRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function isSafeWorkspaceKeySegment(key: string): boolean {
  if (key.length === 0 || key === "." || key === "..") return false;
  if (key.includes("/") || key.includes("\\") || key.includes("\0")) return false;
  return true;
}

export async function promptForWorkspaceMapping(
  sourceWorkspaceKeys: string[],
  chatsWorkspaceKeys: string[],
  logger: ReturnType<typeof getLogger>
): Promise<Map<string, string> | null> {
  if (sourceWorkspaceKeys.length === 0) {
    return new Map();
  }

  const mapping = new Map<string, string>();

  for (const src of sourceWorkspaceKeys) {
    const picks: vscode.QuickPickItem[] = [
      ...chatsWorkspaceKeys.map((k) => ({ label: k, description: k })),
      { label: "Enter custom workspace key…", description: "__custom__" },
    ];
    picks.unshift({ label: "(Cancel import)", description: "__cancel__" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source chats workspace "${src}" to a local ${USER_LABEL_DOT_CURSOR_CHATS} subdirectory`,
      placeHolder: "Select the destination workspace key for store.db restoration",
    });

    if (!selected || selected.description === "__cancel__") {
      logger.appendLine(
        `[${new Date().toISOString()}] Transcript import cancelled during workspace mapping`
      );
      return null;
    }

    if (selected.description === "__custom__") {
      const raw = await vscode.window.showInputBox({
        prompt: `Target workspace key for source "${src}" (single directory name under ${USER_LABEL_DOT_CURSOR_CHATS}/)`,
        validateInput: (v) => {
          if (!v || !isSafeWorkspaceKeySegment(v.trim())) {
            return "Use one non-empty path segment without slashes.";
          }
          return undefined;
        },
      });
      if (raw === undefined) {
        return null;
      }
      mapping.set(src, raw.trim());
    } else if (selected.description) {
      mapping.set(src, selected.description);
    }
  }

  return mapping;
}

export async function preflightV2ConversationImport(params: {
  gistData: GistResponse;
  manifest: TranscriptManifestV2;
  conversation: TranscriptBundleConversationEntry;
  targetProject: ProjectInfo;
  workspaceMapping: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const { gistData, manifest, conversation, targetProject, workspaceMapping } = params;
  const errors: string[] = [];

  const artifactIds = [
    ...conversation.transcriptArtifacts,
    conversation.sidebarArtifact,
    ...(conversation.storeArtifact ? [conversation.storeArtifact] : []),
  ];

  for (const artifactId of artifactIds) {
    const entry = manifest.artifacts[artifactId];
    if (!entry) {
      errors.push(`Import preflight failed: Missing manifest entry for "${artifactId}".`);
      continue;
    }

    const gistFile = gistData.files[syncKeyToGistFileName(artifactId)];
    if (!gistFile) {
      errors.push(`Import preflight failed: Bundle file missing for "${artifactId}".`);
      continue;
    }

    let content: Buffer;
    try {
      content = decodeTranscriptArtifact(gistFile.content, entry.encoding);
    } catch {
      errors.push(`Import preflight failed: Failed to decode artifact "${artifactId}".`);
      continue;
    }

    const checksum = computeArtifactChecksum(content);
    if (checksum !== entry.checksum) {
      errors.push(`Import preflight failed: Checksum mismatch for "${artifactId}".`);
    }

    if (entry.kind === "store") {
      const swk = entry.sourceWorkspaceKey;
      if (typeof swk !== "string" || swk.length === 0) {
        errors.push(
          `Import preflight failed: Store "${artifactId}" has no sourceWorkspaceKey; re-export with Cursor Sync or deselect this conversation.`
        );
      } else {
        const mapped = workspaceMapping.get(swk);
        if (typeof mapped !== "string" || mapped.length === 0) {
          errors.push(
            `Import preflight failed: Store "${artifactId}": map source workspace "${swk}" to a local chats key.`
          );
        } else if (!isSafeWorkspaceKeySegment(mapped)) {
          errors.push(
            `Import preflight failed: Store destination workspace key "${mapped}" is not a safe path segment.`
          );
        } else {
          const parent = path.join(resolveChatsRoot(), mapped);
          try {
            await fs.mkdir(parent, { recursive: true });
          } catch {
            errors.push(
              `Import preflight failed: Cannot create or access chats directory "${parent}" for store restore.`
            );
          }
        }
      }
    }
  }

  try {
    await fs.access(targetProject.fullPath);
  } catch {
    errors.push(`Import preflight failed: Target project directory missing: ${targetProject.fullPath}.`);
  }

  try {
    await fs.mkdir(resolveChatsRoot(), { recursive: true });
  } catch {
    errors.push(`Import preflight failed: Cannot access chats root ${resolveChatsRoot()}.`);
  }

  return errors;
}
