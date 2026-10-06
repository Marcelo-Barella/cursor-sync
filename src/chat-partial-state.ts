import * as fs from "node:fs/promises";
import { nodeProcessPid, systemTmpDir } from "./os-runtime.js";
import * as path from "node:path";
import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceIdentifier } from "./chat-workspace-context.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows } = __chatPersistenceInternals;

export const PARTIAL_STATE_STRIPPED = new Set([
  "capabilities",
  "conversationActionManager",
  "agentSessionId",
]);

export function clearSessionBindingInTree(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "requestId") {
        out[k] = "";
      } else if (k === "workspaceUris") {
        out[k] = [];
      } else if (PARTIAL_STATE_STRIPPED.has(k)) {
        continue;
      } else {
        out[k] = clearSessionBindingInTree(v);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clearSessionBindingInTree(item));
  }
  return value;
}

export type PartialState = Record<string, unknown>;

export interface BundleToPartialStateOptions {
  workspaceIdentifier?: WorkspaceIdentifier | Record<string, unknown> | null;
}

export interface StoreDbIndex {
  meta: Record<string, unknown>;
  blobCount: number;
  error?: string;
}

function composerTimestampMs(record: Record<string, unknown>): number {
  let best = 0;
  for (const field of ["lastUpdatedAt", "lastOpenedAt", "createdAt"] as const) {
    const raw = record[field];
    if (typeof raw === "number" && raw > 0) {
      const v = Math.trunc(raw);
      best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      if (/^\d+$/.test(raw.trim())) {
        const v = parseInt(raw.trim(), 10);
        best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
      } else {
        const parsed = Date.parse(raw.replace("Z", "+00:00"));
        if (!Number.isNaN(parsed)) {
          best = Math.max(best, parsed);
        }
      }
    }
  }
  return best;
}

function bundleCreatedAtMs(bundle: Record<string, unknown>): number {
  const rawTs = bundle.createdAt;
  if (typeof rawTs === "string") {
    const parsed = Date.parse(rawTs.replace("Z", "+00:00"));
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function sidebarHeaderRow(
  sidebarSnapshot: Record<string, unknown> | null | undefined,
  conversationId: string
): Record<string, unknown> | null {
  if (!sidebarSnapshot || typeof sidebarSnapshot !== "object") {
    return null;
  }
  const headers = sidebarSnapshot.composerHeaders;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }
  const allComposers = (headers as Record<string, unknown>).allComposers;
  if (!Array.isArray(allComposers)) {
    return null;
  }
  for (const entry of allComposers) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).composerId === conversationId
    ) {
      return entry as Record<string, unknown>;
    }
  }
  return null;
}

function sidebarRichComposerBlob(
  sidebarSnapshot: Record<string, unknown> | null | undefined,
  conversationId: string
): Record<string, unknown> | null {
  if (!sidebarSnapshot || typeof sidebarSnapshot !== "object") {
    return null;
  }
  const data = sidebarSnapshot.composerData;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const keyed = (data as Record<string, unknown>)[conversationId];
  if (keyed && typeof keyed === "object" && !Array.isArray(keyed)) {
    const obj = keyed as Record<string, unknown>;
    if (Object.keys(obj).length > 0) {
      return obj;
    }
    return null;
  }
  const composers = (data as Record<string, unknown>).allComposers;
  if (Array.isArray(composers)) {
    for (const entry of composers) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).composerId === conversationId
      ) {
        return entry as Record<string, unknown>;
      }
    }
  }
  return null;
}

export function partialStateHasConversationContent(
  partial: Record<string, unknown>
): boolean {
  const cs = partial.conversationState;
  if (typeof cs === "string") {
    if (cs.length > 1 && cs.startsWith("~")) {
      return true;
    }
    if (cs.startsWith("{") && cs.length > 2) {
      return true;
    }
  } else if (cs && typeof cs === "object" && !Array.isArray(cs)) {
    if (Object.keys(cs as Record<string, unknown>).length > 0) {
      return true;
    }
  }
  const map = partial.conversationMap;
  if (map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0) {
    return true;
  }
  const headers = partial.fullConversationHeadersOnly;
  if (Array.isArray(headers) && headers.length > 0) {
    return true;
  }
  return false;
}

export function partialStateForCreateNewCommand(
  partial: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...partial };
  const cs = out.conversationState;
  if (typeof cs === "string" && (cs.startsWith("~") || cs.startsWith("{"))) {
    delete out.conversationState;
  }
  return out;
}

export function partialStateSafeForCreateNew(partial: Record<string, unknown>): boolean {
  const safe = partialStateForCreateNewCommand(partial);
  const map = safe.conversationMap;
  if (map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0) {
    return true;
  }
  const headers = safe.fullConversationHeadersOnly;
  if (Array.isArray(headers) && headers.length > 0) {
    return true;
  }
  const cs = safe.conversationState;
  return !!cs && typeof cs === "object" && !Array.isArray(cs) && Object.keys(cs).length > 0;
}

export function applyRichComposerEntryToPartialState(
  partial: PartialState,
  rich: Record<string, unknown>,
  conversationId: string
): void {
  mergeRichComposerIntoPartial(partial, rich, conversationId);
  const cleared = clearSessionBindingInTree(partial);
  if (cleared && typeof cleared === "object" && !Array.isArray(cleared)) {
    Object.assign(partial, cleared as PartialState);
  }
  partial.requestId = "";
  partial.workspaceUris = [];
}

function mergeRichComposerIntoPartial(
  partial: PartialState,
  rich: Record<string, unknown>,
  conversationId: string
): void {
  for (const [key, value] of Object.entries(rich)) {
    if (PARTIAL_STATE_STRIPPED.has(key) || key === "composerId") {
      continue;
    }
    partial[key] = value;
  }
  partial.composerId = conversationId;
}

function rebindPartialForImport(
  partial: PartialState,
  conversationId: string,
  name: string,
  workspaceIdentifier: WorkspaceIdentifier | Record<string, unknown> | null | undefined
): void {
  if (!workspaceIdentifier || typeof workspaceIdentifier !== "object" || Array.isArray(workspaceIdentifier)) {
    return;
  }
  const nowMs = Date.now();
  partial.composerId = conversationId;
  partial.workspaceIdentifier = workspaceIdentifier;
  partial.name = name;
  partial.createdAt = nowMs;
  partial.lastUpdatedAt = nowMs;
  partial.lastOpenedAt = nowMs;
  if ("conversationCheckpointLastUpdatedAt" in partial) {
    partial.conversationCheckpointLastUpdatedAt = nowMs;
  }
  const headers = partial.fullConversationHeadersOnly;
  if (Array.isArray(headers)) {
    partial.fullConversationHeadersOnly = headers.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const rec = entry as Record<string, unknown>;
      if (rec.composerId !== conversationId) {
        return entry;
      }
      return {
        ...rec,
        workspaceIdentifier,
        createdAt: nowMs,
        lastUpdatedAt: nowMs,
        lastOpenedAt: nowMs,
      };
    });
  }
}

export function bundleToPartialState(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string,
  options: BundleToPartialStateOptions = {}
): PartialState {
  const cid = conversationId.trim();
  const bundleRec = bundle as Record<string, unknown>;
  const snap = bundleRec.sidebarSnapshot;
  const snapDict =
    snap && typeof snap === "object" && !Array.isArray(snap)
      ? (snap as Record<string, unknown>)
      : null;
  const header = sidebarHeaderRow(snapDict, cid);

  const title =
    typeof bundleRec.title === "string"
      ? bundleRec.title
      : null;
  const name =
    title ??
    (header && typeof header.name === "string" ? header.name : null) ??
    cid;

  let ts = bundleCreatedAtMs(bundleRec);
  if (header) {
    const headerTs = composerTimestampMs(header);
    if (headerTs > 0) {
      ts = headerTs;
    }
  }

  const partial: PartialState = {
    composerId: cid,
    name,
    type: (header?.type as string | undefined) ?? "head",
    unifiedMode: (header?.unifiedMode as string | undefined) ?? "agent",
    forceMode: (header?.forceMode as string | undefined) ?? "edit",
    createdAt:
      header?.createdAt !== undefined && header.createdAt !== null
        ? header.createdAt
        : ts,
    lastUpdatedAt:
      header?.lastUpdatedAt !== undefined && header.lastUpdatedAt !== null
        ? header.lastUpdatedAt
        : ts,
    lastOpenedAt:
      header?.lastOpenedAt !== undefined && header.lastOpenedAt !== null
        ? header.lastOpenedAt
        : ts,
  };

  let wi: WorkspaceIdentifier | Record<string, unknown> | null | undefined =
    options.workspaceIdentifier;
  if (wi == null && bundleRec.workspaceIdentifier != null) {
    const bwi = bundleRec.workspaceIdentifier;
    if (typeof bwi === "object" && !Array.isArray(bwi)) {
      wi = bwi as Record<string, unknown>;
    }
  }
  if (wi == null && header?.workspaceIdentifier != null) {
    const hwi = header.workspaceIdentifier;
    if (typeof hwi === "object" && !Array.isArray(hwi)) {
      wi = hwi as Record<string, unknown>;
    }
  }
  if (wi != null) {
    partial.workspaceIdentifier = wi;
  }

  if (header) {
    for (const field of [
      "subtitle",
      "hasUnreadMessages",
      "isArchived",
      "isDraft",
      "contextUsagePercent",
      "filesChangedCount",
      "conversationCheckpointLastUpdatedAt",
    ] as const) {
      if (field in header) {
        partial[field] = header[field];
      }
    }
  }

  const rich = sidebarRichComposerBlob(snapDict, cid);
  if (rich) {
    mergeRichComposerIntoPartial(partial, rich, cid);
  }

  const cleared = clearSessionBindingInTree(partial);
  if (cleared && typeof cleared === "object" && !Array.isArray(cleared)) {
    Object.assign(partial, cleared as PartialState);
  }
  rebindPartialForImport(partial, cid, name, options.workspaceIdentifier);
  partial.requestId = "";
  if (rich) {
    partial.workspaceUris = [];
  }

  return partial;
}

export function sidebarSnapshotHasComposerData(
  bundle: ChatBundle | Record<string, unknown>,
  conversationId: string
): boolean {
  const snap = (bundle as Record<string, unknown>).sidebarSnapshot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    return false;
  }
  const cd = (snap as Record<string, unknown>).composerData;
  if (!cd || typeof cd !== "object" || Array.isArray(cd)) {
    return false;
  }
  const val = (cd as Record<string, unknown>)[conversationId];
  return val != null && typeof val === "object" && !Array.isArray(val) && Object.keys(val as object).length > 0;
}

function parseMetaValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 2 && trimmed.length % 2 === 0) {
      try {
        return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
      } catch {
        return value;
      }
    }
    return value;
  }
}

export function storeMetaRecord(storeIndex: StoreDbIndex): Record<string, unknown> | null {
  const raw = storeIndex.meta["0"] ?? storeIndex.meta[0];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

export async function decodeStoreDbIndex(
  storeBytes: Buffer | Uint8Array
): Promise<StoreDbIndex> {
  const out: StoreDbIndex = { meta: {}, blobCount: 0 };
  if (!storeBytes || storeBytes.length === 0) {
    return out;
  }

  const tmpPath = path.join(
    systemTmpDir(),
    `cursor-sync-store-index-${nodeProcessPid()}-${Date.now()}.db`
  );

  try {
    await fs.writeFile(tmpPath, storeBytes);
    const tables = await querySqliteRows(
      tmpPath,
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const tableNames = new Set(
      tables
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string")
    );

    if (tableNames.has("meta")) {
      const metaRows = await querySqliteRows(tmpPath, "SELECT key, value FROM meta");
      const metaOut: Record<string, unknown> = {};
      for (const row of metaRows) {
        const key = row.key;
        if (typeof key === "string" || typeof key === "number") {
          metaOut[String(key)] = parseMetaValue(row.value);
        }
      }
      out.meta = metaOut;
    }

    if (tableNames.has("blobs")) {
      const countRows = await querySqliteRows(
        tmpPath,
        "SELECT COUNT(*) AS c FROM blobs"
      );
      const c = countRows[0]?.c;
      out.blobCount =
        typeof c === "number"
          ? Math.trunc(c)
          : typeof c === "string"
            ? parseInt(c, 10) || 0
            : 0;
    }
  } catch {
    out.error = "unreadable";
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }

  return out;
}
