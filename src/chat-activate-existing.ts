import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildActivationManifest,
  normalizeActivationManifest,
  runComposerActivation,
} from "./chat-import-activate.js";
import {
  buildMinimalComposerDataForOpen,
  filterComposerDataForConversation,
  headersPayloadForImport,
  prepareComposerDataForImport,
  prepareHeadersForImport,
} from "./chat-import-merge.js";
import { buildChatBundle, type ChatBundle } from "./chat-persistence.js";
import { runPythonDiskImport } from "./chat-transport-scripts.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import {
  decodeStoreDbIndex,
  sidebarSnapshotHasComposerData,
  storeMetaRecord,
} from "./chat-partial-state.js";
import {
  escapeSqlLiteral,
  getComposerDisplayName,
  loadComposerNameIndex,
} from "./composer-merge.js";
import type { WorkspaceIdentifier as MergeWorkspaceIdentifier } from "./chat-import-merge.js";
import {
  requireWorkspaceContext,
  stateDbPathForWorkspaceStorageId,
  type WorkspaceContext,
} from "./chat-workspace-context.js";

function mergeWorkspaceIdentifier(
  wi: WorkspaceContext["workspaceIdentifier"]
): MergeWorkspaceIdentifier {
  return { id: wi.id, uri: wi.uri as unknown as Record<string, unknown> };
}
import { getLogger } from "./diagnostics.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows, runSqliteScript } = __chatPersistenceInternals;

type OpenBundleMode = "export-bundle" | "header-only" | "minimal-stub" | "existing-rich";

const noopProgress: vscode.Progress<{ message?: string; increment?: number }> = {
  report: () => {},
};

async function globalCursorDiskKvHasComposer(conversationId: string): Promise<boolean> {
  const globalDb = path.join(resolveExtensionSyncRoots().cursorUser, "globalStorage", "state.vscdb");
  try {
    const keyLit = escapeSqlLiteral(`composerData:${conversationId}`);
    const rows = await querySqliteRows(
      globalDb,
      `SELECT 1 AS ok FROM cursorDiskKV WHERE key = '${keyLit}' LIMIT 1;`,
      { retries: 1 }
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function syncDiskLayersForOpen(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  wsCtx: WorkspaceContext
): Promise<boolean> {
  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-open-${bundle.conversationId}-${Date.now()}.json`
  );
  await fs.writeFile(tmpPath, JSON.stringify(bundle, null, 2), "utf8");
  const stateDb = stateDbPathForWorkspaceStorageId(wsCtx.workspaceStorageId);
  const outcome = await runPythonDiskImport({
    bundlePath: tmpPath,
    workspaceFolder: wsCtx.folderFsPath,
    stateDbPath: stateDb,
    extensionPath: context.extensionPath,
    syncGlobal: true,
    pinRecent: true,
    log: (message) => getLogger().appendLine(message),
  });
  await fs.unlink(tmpPath).catch(() => {});
  return outcome.ok;
}

function resolveOpenBundleMode(
  bundle: ChatBundle,
  conversationId: string,
  options: {
    storeOnDisk: boolean;
    globalKvPresent: boolean;
    existingComposerData?: Record<string, unknown> | null;
  }
): OpenBundleMode {
  if (options.existingComposerData) {
    return "existing-rich";
  }
  if (sidebarSnapshotHasComposerData(bundle, conversationId)) {
    return "export-bundle";
  }
  if (options.storeOnDisk && options.globalKvPresent) {
    return "header-only";
  }
  if (options.storeOnDisk) {
    return "header-only";
  }
  return "minimal-stub";
}

function bundleForActivation(
  exportBundle: ChatBundle,
  conversationId: string,
  title: string,
  wsCtx: WorkspaceContext,
  mode: OpenBundleMode,
  existingComposerData?: Record<string, unknown> | null
): ChatBundle {
  if (mode === "export-bundle") {
    return exportBundle;
  }
  return buildBundleForExistingChat(conversationId, title, wsCtx, {
    storeOnDisk: mode === "header-only",
    existingComposerData,
  }).bundle;
}

function composerDataEntryIsRich(entry: Record<string, unknown>): boolean {
  const headers = entry.fullConversationHeadersOnly;
  if (Array.isArray(headers) && headers.length > 0) {
    return true;
  }
  const map = entry.conversationMap;
  return !!map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0;
}

async function readExistingComposerDataEntry(
  dbPath: string,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  const rows = await querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;",
    { retries: 2 }
  );
  const raw = rows[0]?.value;
  const asStr =
    typeof raw === "string" ? raw : raw != null ? JSON.stringify(raw) : undefined;
  if (!asStr?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(asStr) as Record<string, unknown>;
    const filtered = filterComposerDataForConversation(parsed, conversationId);
    const entry = filtered[conversationId];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (composerDataEntryIsRich(rec)) {
        return rec;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildBundleForExistingChat(
  conversationId: string,
  title: string,
  wsCtx: WorkspaceContext,
  options: {
    storeOnDisk: boolean;
    existingComposerData?: Record<string, unknown> | null;
  }
): { bundle: ChatBundle; mode: OpenBundleMode } {
  const nowMs = Date.now();
  const stub: ChatBundle = {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: new Date(nowMs).toISOString(),
    conversationId,
    title,
    subtitle: "",
    previewText: "",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
  };
  const headersPayload = headersPayloadForImport(stub);
  const snapshot: Record<string, unknown> = { composerHeaders: headersPayload };

  let mode: OpenBundleMode;
  if (options.existingComposerData) {
    snapshot.composerData = { [conversationId]: options.existingComposerData };
    mode = "existing-rich";
  } else if (options.storeOnDisk) {
    mode = "header-only";
  } else {
    snapshot.composerData = {
      [conversationId]: buildMinimalComposerDataForOpen(
        conversationId,
        title,
        mergeWorkspaceIdentifier(wsCtx.workspaceIdentifier),
        nowMs
      ),
    };
    mode = "minimal-stub";
  }

  return {
    bundle: { ...stub, sidebarSnapshot: snapshot },
    mode,
  };
}

async function ensureSidebarStateForOpen(
  conversationId: string,
  wsCtx: WorkspaceContext,
  bundle: ChatBundle
): Promise<boolean> {
  const dbPath = stateDbPathForWorkspaceStorageId(wsCtx.workspaceStorageId);
  try {
    await fs.access(dbPath);
  } catch {
    return false;
  }

  const rows = await querySqliteRows(
    dbPath,
    "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');",
    { retries: 2 }
  );
  let existingHeadersStr: string | undefined;
  let existingDataStr: string | undefined;
  for (const row of rows) {
    const key = String(row.key ?? "");
    const value = row.value;
    const asStr =
      typeof value === "string"
        ? value
        : value != null
          ? JSON.stringify(value)
          : undefined;
    if (key === "composer.composerHeaders") {
      existingHeadersStr = asStr;
    }
    if (key === "composer.composerData") {
      existingDataStr = asStr;
    }
  }

  const wi = mergeWorkspaceIdentifier(wsCtx.workspaceIdentifier);
  const mergedHeaders = prepareHeadersForImport(
    existingHeadersStr,
    bundle,
    conversationId,
    wi,
    { pinRecent: true }
  );
  const mergedData = prepareComposerDataForImport(
    existingDataStr,
    bundle,
    conversationId,
    wi
  );
  const escapedHeaders = escapeSqlLiteral(JSON.stringify(mergedHeaders));
  const escapedData = escapeSqlLiteral(JSON.stringify(mergedData));
  const script = [
    "BEGIN IMMEDIATE;",
    `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';`,
    `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');`,
    `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';`,
    `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');`,
    "COMMIT;",
  ].join("\n");
  await runSqliteScript(dbPath, script);
  return true;
}

export async function activateExistingChat(
  context: vscode.ExtensionContext,
  conversationId: string,
  workspaceFolder: vscode.Uri
): Promise<{ ok: boolean; composerId?: string; stagedOnly: boolean }> {
  const wsCtx = await requireWorkspaceContext({ workspaceFolder: workspaceFolder.fsPath });
  const storeDbPath = path.join(
    resolveExtensionSyncRoots().dotCursor,
    "chats",
    wsCtx.chatsWorkspaceKey,
    conversationId,
    "store.db"
  );
  let storeDbExists = false;
  let storeBlobCount = 0;
  let storeMetaName: string | undefined;
  try {
    const stat = await fs.stat(storeDbPath);
    storeDbExists = stat.isFile();
    if (storeDbExists) {
      const storeBytes = await fs.readFile(storeDbPath);
      const storeIndex = await decodeStoreDbIndex(storeBytes);
      storeBlobCount = storeIndex.blobCount;
      const meta = storeMetaRecord(storeIndex);
      if (meta && typeof meta.name === "string") {
        storeMetaName = meta.name;
      }
    }
  } catch {
    storeDbExists = false;
    storeBlobCount = 0;
  }

  const nameIndex = await loadComposerNameIndex();
  const title = getComposerDisplayName(nameIndex, conversationId) ?? conversationId;
  let globalKvPresent = await globalCursorDiskKvHasComposer(conversationId);
  const syntheticStore = storeMetaName === "New Agent";

  let { bundle: exportBundle } = await buildChatBundle(
    context,
    conversationId,
    noopProgress,
    { workspaceKey: wsCtx.chatsWorkspaceKey }
  );

  const needsDiskSync =
    exportBundle.transcriptFiles.length > 0 &&
    (!globalKvPresent || syntheticStore || !sidebarSnapshotHasComposerData(exportBundle, conversationId));

  let diskSyncRan = false;
  if (needsDiskSync) {
    diskSyncRan = await syncDiskLayersForOpen(context, exportBundle, wsCtx);
    globalKvPresent = await globalCursorDiskKvHasComposer(conversationId);
    const rebuilt = await buildChatBundle(context, conversationId, noopProgress, {
      workspaceKey: wsCtx.chatsWorkspaceKey,
    });
    exportBundle = rebuilt.bundle;
  }

  const stateDbPath = stateDbPathForWorkspaceStorageId(wsCtx.workspaceStorageId);
  const existingComposerData = await readExistingComposerDataEntry(stateDbPath, conversationId);
  const storeOnDisk = storeDbExists && storeBlobCount > 0;
  let bundleMode = resolveOpenBundleMode(exportBundle, conversationId, {
    storeOnDisk,
    globalKvPresent,
    existingComposerData,
  });
  const activationBundle = bundleForActivation(
    exportBundle,
    conversationId,
    title,
    wsCtx,
    bundleMode,
    existingComposerData
  );
  await ensureSidebarStateForOpen(conversationId, wsCtx, activationBundle);

  const raw = buildActivationManifest(activationBundle, conversationId, wsCtx);
  const manifest = normalizeActivationManifest(
    raw as unknown as Record<string, unknown>
  );

  const outcome = await runComposerActivation(manifest, {
    stagePending: false,
    acceptOpenWithoutHandle: false,
    handlePreloadTimeoutMs: diskSyncRan ? 12000 : 6000,
    handlePostOpenTimeoutMs: diskSyncRan ? 10000 : 4000,
    log: (message) => getLogger().appendLine(message),
  });

  if (!outcome.ok) {
    const { openTranscriptForConversation } = await import("./sidebar/chats-tab.js");
    const openedTranscript = await openTranscriptForConversation(conversationId);
    if (openedTranscript) {
      const reload = "Reload Window";
      const choice = await vscode.window.showWarningMessage(
        "Native chat UI could not be opened; opened the transcript file instead. Reload Window, then try Open again for the composer view.",
        reload
      );
      if (choice === reload) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else {
      const hint = !globalKvPresent && exportBundle.transcriptFiles.length > 0
        ? "Disk sync for composer index failed. Re-import the chat bundle, then Open again."
        : storeDbExists
          ? "Composer is on disk but IDE activation failed. Re-import the bundle or Reload Window, then Open again."
          : "store.db missing for this chat; re-import the bundle first.";
      void vscode.window.showWarningMessage(`Could not open chat: ${hint}`);
    }
  }

  return {
    ok: outcome.ok,
    composerId: outcome.composerId,
    stagedOnly: outcome.stagedOnly,
  };
}
