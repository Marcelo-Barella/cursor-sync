import type { ChatBundle } from "./chat-persistence.js";
import {
  buildComposerNameIndexFromHeadersRaw,
  getComposerDisplayName,
} from "./composer-merge.js";
import {
  buildChatsKeyToFolderMap,
  scanWorkspaceStorageForFolder,
  stateDbPathForWorkspaceStorageId,
} from "./chat-workspace-context.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import { resolveConversationDisplayTitle } from "./transcript-bundle.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import { listGlobalStateVscdbPaths } from "./transcripts-sqlite.js";

const HEADERS_SQL =
  "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1";

async function loadComposerNameIndexFromDbPath(dbPath: string): Promise<Map<string, string>> {
  try {
    const rows = await __chatPersistenceInternals.querySqliteRows(dbPath, HEADERS_SQL);
    const raw = rows[0]?.value;
    if (typeof raw === "string" && raw.length > 0) {
      return buildComposerNameIndexFromHeadersRaw(raw);
    }
  } catch {
    /* locked or missing */
  }
  return new Map();
}

export async function loadComposerNameIndexForChatsWorkspaceKey(
  chatsWorkspaceKey: string
): Promise<Map<string, string>> {
  const { cursorUser } = resolveExtensionSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);
  const folderFsPath = folderMap.get(chatsWorkspaceKey);
  if (!folderFsPath) {
    return new Map();
  }
  const workspaceStorageId = await scanWorkspaceStorageForFolder(folderFsPath);
  if (!workspaceStorageId) {
    return new Map();
  }
  return loadComposerNameIndexFromDbPath(
    stateDbPathForWorkspaceStorageId(workspaceStorageId)
  );
}

export async function loadGlobalComposerNameIndex(): Promise<Map<string, string>> {
  for (const dbPath of await listGlobalStateVscdbPaths()) {
    const index = await loadComposerNameIndexFromDbPath(dbPath);
    if (index.size > 0) {
      return index;
    }
  }
  return new Map();
}

function composerNameFromBundleSnapshot(
  bundle: ChatBundle,
  conversationId: string
): string | undefined {
  const headers = bundle.sidebarSnapshot?.composerHeaders;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const index = buildComposerNameIndexFromHeadersRaw(JSON.stringify(headers));
  return getComposerDisplayName(index, conversationId);
}

export async function resolveComposerConversationTitle(options: {
  conversationId: string;
  chatsWorkspaceKey?: string;
  transcriptContent?: string | null;
  bundle?: ChatBundle;
  workspaceIndex?: Map<string, string>;
  globalIndex?: Map<string, string>;
}): Promise<string> {
  const { conversationId, bundle } = options;

  if (bundle) {
    const fromSnapshot = composerNameFromBundleSnapshot(bundle, conversationId);
    if (fromSnapshot) {
      return fromSnapshot;
    }
    const bundleTitle = bundle.title?.trim();
    if (bundleTitle) {
      return bundleTitle;
    }
  }

  const workspaceIndex =
    options.workspaceIndex ??
    (options.chatsWorkspaceKey
      ? await loadComposerNameIndexForChatsWorkspaceKey(options.chatsWorkspaceKey)
      : new Map());
  const workspaceName = getComposerDisplayName(workspaceIndex, conversationId);

  const globalIndex = options.globalIndex ?? (await loadGlobalComposerNameIndex());
  const globalName = getComposerDisplayName(globalIndex, conversationId);

  return resolveConversationDisplayTitle({
    conversationId,
    composerName: workspaceName ?? globalName ?? null,
    transcriptContent: options.transcriptContent ?? null,
  });
}
