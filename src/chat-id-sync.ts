import * as fs from "node:fs/promises";
import { USER_LABEL_DOT_CURSOR_CHATS } from "./paths.js";
import * as path from "node:path";
import type { SyncManifestChatHistoryEntry } from "./sync-manifest.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";

function chatsRootPath(): string {
  return path.join(resolveExtensionSyncRoots().dotCursor, "chats");
}

/**
 * Pointer (ItemTable composer.composerHeaders) and content (~/.cursor/chats/<ws>/<id>/store.db)
 * must share the same `composerId` / `conversation_id` and the same workspace folder name Cursor uses.
 */

export async function listWorkspaceKeysUnderChatsRoot(): Promise<string[]> {
  const root = chatsRootPath();
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

export async function validateWorkspaceKeysForImport(
  keys: string[]
): Promise<{ ok: boolean; available: string[]; message?: string }> {
  const unique = [...new Set(keys)].filter((k) => k.length > 0);
  const available = await listWorkspaceKeysUnderChatsRoot();
  if (available.length === 0) {
    return {
      ok: true,
      available,
      message:
        `No workspace folders under ${USER_LABEL_DOT_CURSOR_CHATS}/ yet. Cursor creates one per workspace when you use Agent chat. Set workspace_key to that folder name after it exists, or import may not show threads.`,
    };
  }
  const missing = unique.filter((k) => !available.includes(k));
  if (missing.length > 0) {
    return {
      ok: false,
      available,
      message: `workspace_key must match a directory under ${USER_LABEL_DOT_CURSOR_CHATS}/. Not found: ${missing.join(", ")}. On this machine: ${available.join(", ")}.`,
    };
  }
  return { ok: true, available };
}

function inlineTimestampToIso(raw: number | string | undefined): string {
  if (raw === undefined) {
    return new Date().toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** One composer header blob per chat row; mergeComposerHeadersChain combines them. */
export function buildComposerHeaderPayloadsFromSyncChatHistory(
  entries: SyncManifestChatHistoryEntry[]
): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const title =
      entry.inline?.title ?? `Chat ${entry.conversation_id.slice(0, 8)}…`;
    const iso = inlineTimestampToIso(entry.inline?.timestamp);
    return {
      allComposers: [
        {
          composerId: entry.conversation_id,
          name: title,
          subtitle: "",
          lastUpdatedAt: iso,
          lastOpenedAt: iso,
          createdAt: iso,
          hasUnreadMessages: false,
          isArchived: false,
          isDraft: false,
        },
      ],
    };
  });
}
