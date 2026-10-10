import * as path from "node:path";
import { parseMetadataOverrides } from "./sync-manifest-overrides.js";

export const SYNC_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface SyncManifestDbTemplate {
  /** Relative path inside landing zone: SQLite file used as store.db template for hydrate path */
  sqlite_file: string;
  /** Optional SQL run on each shadow store.db after hydrate */
  pre_hydrate_sql?: string;
}

export interface SyncManifestChatInline {
  title: string;
  content: Array<{ role: string; content: string }>;
  timestamp: number | string;
}

export interface SyncManifestChatHistoryEntry {
  workspace_key: string;
  conversation_id: string;
  /** Copy this path from landing zone relative to LZ root → shadow store.db */
  store_db_file?: string;
  /** If no store_db_file: hydrate db_template + inline */
  inline?: SyncManifestChatInline;
}

export interface SyncManifestMetadataOverrides {
  /** Raw SQL executed on shadow state.vscdb (in order) */
  state_vscdb_sql?: string[];
  /** Payloads merged additively into composer.composerHeaders */
  composer_header_payloads?: Array<Record<string, unknown>>;
}

export interface SyncManifestV1 {
  schema_version: typeof SYNC_MANIFEST_SCHEMA_VERSION;
  state_target: "global" | "workspace";
  workspace_key: string;
  workspace_storage_folder_id?: string;
  db_template: SyncManifestDbTemplate;
  chat_history: SyncManifestChatHistoryEntry[];
  metadata_overrides: SyncManifestMetadataOverrides;
}

export interface ParseSyncManifestOk {
  ok: true;
  manifest: SyncManifestV1;
}

export interface ParseSyncManifestErr {
  ok: false;
  errors: string[];
}

export type ParseSyncManifestResult = ParseSyncManifestOk | ParseSyncManifestErr;

function isSafeSegment(seg: string): boolean {
  if (seg.length === 0 || seg === "." || seg === "..") {
    return false;
  }
  if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
    return false;
  }
  return true;
}

function resolveLandingPath(landingZoneRoot: string, relative: string): string {
  const base = path.resolve(landingZoneRoot);
  const joined = path.resolve(base, relative);
  const rel = path.relative(base, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes landing zone");
  }
  return joined;
}

export function parseSyncManifestJson(
  raw: string,
  landingZoneRoot: string
): ParseSyncManifestResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, errors: ["Invalid JSON"] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Root must be an object"] };
  }
  const root = parsed as Record<string, unknown>;

  if (root.schema_version !== SYNC_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SYNC_MANIFEST_SCHEMA_VERSION}`);
  }

  const stateTarget = root.state_target;
  if (stateTarget !== "global" && stateTarget !== "workspace") {
    errors.push('state_target must be "global" or "workspace"');
  }

  const workspaceKey = root.workspace_key;
  if (typeof workspaceKey !== "string" || !isSafeSegment(workspaceKey)) {
    errors.push("workspace_key must be a safe non-empty path segment");
  }

  const wsFolder = root.workspace_storage_folder_id;
  if (stateTarget === "workspace") {
    if (typeof wsFolder !== "string" || !isSafeSegment(wsFolder)) {
      errors.push("workspace_storage_folder_id required for workspace state_target");
    }
  }

  const dbTemplate = root.db_template;
  if (!dbTemplate || typeof dbTemplate !== "object" || Array.isArray(dbTemplate)) {
    errors.push("db_template must be an object");
  } else {
    const dt = dbTemplate as Record<string, unknown>;
    if (typeof dt.sqlite_file !== "string" || dt.sqlite_file.trim().length === 0) {
      errors.push("db_template.sqlite_file must be a non-empty string");
    }
  }

  const meta = root.metadata_overrides;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    errors.push("metadata_overrides must be an object");
  }

  const chatsRaw = root.chat_history;
  if (!Array.isArray(chatsRaw) || chatsRaw.length === 0) {
    errors.push("chat_history must be a non-empty array");
  }

  const chat_history: SyncManifestChatHistoryEntry[] = [];

  if (Array.isArray(chatsRaw)) {
    for (let i = 0; i < chatsRaw.length; i++) {
      const c = chatsRaw[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        errors.push(`chat_history[${i}]: expected object`);
        continue;
      }
      const rec = c as Record<string, unknown>;
      const wk = rec.workspace_key;
      const cid = rec.conversation_id;
      const sdf = rec.store_db_file;
      const inline = rec.inline;

      if (typeof wk !== "string" || !isSafeSegment(wk)) {
        errors.push(`chat_history[${i}].workspace_key invalid`);
      }
      if (typeof cid !== "string" || cid.trim().length === 0) {
        errors.push(`chat_history[${i}].conversation_id invalid`);
      }
      if (sdf !== undefined && typeof sdf !== "string") {
        errors.push(`chat_history[${i}].store_db_file must be string`);
      }
      if (inline !== undefined && (typeof inline !== "object" || inline === null || Array.isArray(inline))) {
        errors.push(`chat_history[${i}].inline must be object`);
      }

      const hasFile = typeof sdf === "string" && sdf.trim().length > 0;
      const hasInline =
        inline &&
        typeof inline === "object" &&
        !Array.isArray(inline) &&
        typeof (inline as Record<string, unknown>).title === "string" &&
        Array.isArray((inline as Record<string, unknown>).content);

      if (hasFile && hasInline) {
        errors.push(`chat_history[${i}]: specify only one of store_db_file or inline`);
      }
      if (!hasFile && !hasInline) {
        errors.push(`chat_history[${i}]: need store_db_file or inline`);
      }

      if (
        typeof wk === "string" &&
        isSafeSegment(wk) &&
        typeof cid === "string" &&
        cid.trim().length > 0
      ) {
        if (hasFile) {
          chat_history.push({
            workspace_key: wk,
            conversation_id: cid.trim(),
            store_db_file: (sdf as string).trim(),
          });
        } else if (hasInline) {
          const ir = inline as Record<string, unknown>;
          const content = ir.content as unknown[];
          const messages: Array<{ role: string; content: string }> = [];
          for (let mi = 0; mi < content.length; mi++) {
            const m = content[mi];
            if (!m || typeof m !== "object" || Array.isArray(m)) {
              errors.push(`chat_history[${i}].inline.content[${mi}] must be an object`);
              continue;
            }
            const mr = m as Record<string, unknown>;
            if (typeof mr.role !== "string" || typeof mr.content !== "string") {
              errors.push(`chat_history[${i}].inline.content[${mi}] needs string role and content`);
              continue;
            }
            messages.push({ role: mr.role, content: mr.content });
          }
          chat_history.push({
            workspace_key: wk,
            conversation_id: cid.trim(),
            inline: {
              title: String(ir.title),
              content: messages,
              timestamp: (ir.timestamp as number | string) ?? Date.now(),
            },
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const dt = root.db_template as Record<string, unknown>;
  const mo = root.metadata_overrides as Record<string, unknown>;
  const overrides = parseMetadataOverrides(mo);
  if (!overrides.ok) {
    return overrides;
  }
  const { state_vscdb_sql, composer_header_payloads } = overrides.overrides;

  const sqliteRel = String(dt.sqlite_file).trim();
  try {
    resolveLandingPath(landingZoneRoot, sqliteRel);
  } catch {
    return { ok: false, errors: ["db_template.sqlite_file must stay inside landing zone"] };
  }

  for (const ch of chat_history) {
    if (ch.store_db_file) {
      try {
        resolveLandingPath(landingZoneRoot, ch.store_db_file);
      } catch {
        return {
          ok: false,
          errors: [`chat_history store_db_file escapes landing zone: ${ch.store_db_file}`],
        };
      }
    }
  }

  const manifest: SyncManifestV1 = {
    schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
    state_target: stateTarget as "global" | "workspace",
    workspace_key: (workspaceKey as string).trim(),
    workspace_storage_folder_id:
      typeof wsFolder === "string" && wsFolder.length > 0 ? wsFolder.trim() : undefined,
    db_template: {
      sqlite_file: sqliteRel,
      pre_hydrate_sql:
        typeof dt.pre_hydrate_sql === "string" ? dt.pre_hydrate_sql : undefined,
    },
    chat_history,
    metadata_overrides: {
      state_vscdb_sql,
      composer_header_payloads,
    },
  };

  return { ok: true, manifest };
}

export function resolveLandingAssetPath(landingZoneRoot: string, relative: string): string {
  return resolveLandingPath(landingZoneRoot, relative);
}
