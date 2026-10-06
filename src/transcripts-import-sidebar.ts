import * as vscode from "vscode";
import { isWin32Platform } from "./os-runtime.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createBackup, rollbackFromBackup } from "./rollback.js";
import { getLogger } from "./diagnostics.js";
import {
  extractComposerHeadersPayload,
  extractComposerDataPayload,
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  getComposerId,
  mergeComposerDataAdditive,
  mergeComposerHeadersChain,
  escapeSqlLiteral,
} from "./composer-merge.js";
import type { TranscriptBundleArtifactEntry } from "./transcript-bundle.js";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";
import {
  resolveStateDbCandidates,
  resolveImportMergeStateDbCandidates,
  runSqliteScript,
  querySqliteRows,
  isExecFileTimeoutError,
  coerceSqliteValue,
  parseFullJsonValue,
  parseFullComposerHeadersValue,
  filterComposerHeadersByIds,
} from "./transcripts-sqlite.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import type {
  ExportConversationState,
  ComposerHeadersPayload,
  ImportRestoreReport,
  RestoreOperation,
  StateRestoreOutcome,
  SidebarStateEvidence,
} from "./transcripts-internal-types.js";
import type { ProjectInfo } from "./transcripts-discovery.js";

const DELAYED_WRITEBACK_MS = 5_000;

export function stampWorkspaceIdentifierOnPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const list = Array.isArray(payload.allComposers) ? payload.allComposers : [];
  const needsStamp = list.some(
    (c) => c && typeof c === "object" && !Array.isArray(c) && !(c as Record<string, unknown>).workspaceIdentifier
  );
  if (!needsStamp) {
    return payload;
  }
  const wsId = buildCurrentWorkspaceIdentifier();
  if (!wsId) {
    return payload;
  }
  return {
    ...payload,
    allComposers: list.map((c) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return c;
      }
      const rec = c as Record<string, unknown>;
      if (rec.workspaceIdentifier) {
        return rec;
      }
      return { ...rec, workspaceIdentifier: wsId };
    }),
  };
}

function buildCurrentWorkspaceIdentifier(): Record<string, unknown> | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const folder = folders[0]!;
  const fsPath = folder.uri.fsPath;
  return {
    id: crypto.createHash("md5").update(fsPath).digest("hex"),
    uri: {
      $mid: 1,
      fsPath,
      _sep: isWin32Platform() ? 1 : 47,
      external: folder.uri.toString(),
      path: folder.uri.path,
      scheme: folder.uri.scheme,
    },
  };
}

export function mergeStateOutcomeIntoReport(
  base: ImportRestoreReport,
  state: StateRestoreOutcome
): ImportRestoreReport {
  return {
    ...base,
    stateDbMerged: state.stateDbMerged,
    stateDbSkippedNoPayload: state.stateDbSkippedNoPayload,
    stateDbSkippedNoDb: state.stateDbSkippedNoDb,
    statePartial: base.statePartial || state.statePartial,
    warnings: [...base.warnings, ...state.warnings],
  };
}

function collectComposerIdsForConversation(conversationState: ExportConversationState): Set<string> {
  const ids = new Set<string>([conversationState.conversationId]);
  for (const relativePath of conversationState.transcriptRelativePaths) {
    const baseName = path.basename(relativePath, path.extname(relativePath));
    if (baseName) {
      ids.add(baseName);
    }
  }
  return ids;
}

function filterComposerDataPayload(value: unknown, composerIds: ReadonlySet<string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "allComposers" && Array.isArray(entry)) {
      filtered[key] = entry.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const id = getComposerId(item as Record<string, unknown>);
        return id.length > 0 && composerIds.has(id);
      });
      continue;
    }
    if (composerIds.has(key)) {
      filtered[key] = entry;
    } else if (!isLikelyComposerIdKey(key)) {
      filtered[key] = entry;
    }
  }
  return filtered;
}

function isLikelyComposerIdKey(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function buildFallbackComposerHeadersPayload(
  conversationId: string,
  summary: ReturnType<typeof summarizeTranscriptForSidebar>,
  exportedAt: string
): ComposerHeadersPayload {
  const timestamp = summary.lastUpdatedAt ?? exportedAt;
  return {
    allComposers: [
      {
        type: "head",
        composerId: conversationId,
        name: summary.title,
        subtitle: summary.subtitle,
        lastUpdatedAt: timestamp,
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
      },
    ],
  };
}

async function extractSidebarStateEvidence(
  conversationId: string
): Promise<SidebarStateEvidence | undefined> {
  const stateDbCandidates = await resolveStateDbCandidates();
  const escapedConversationId = conversationId.replace(/'/g, "''");

  for (const stateDbPath of stateDbCandidates) {
    let matchedItemTableRows: Array<Record<string, unknown>>;
    let matchedCursorDiskRows: Array<Record<string, unknown>>;
    let composerSummaryRows: Array<Record<string, unknown>>;
    try {
      matchedItemTableRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM ItemTable WHERE value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      matchedCursorDiskRows = await querySqliteRows(
        stateDbPath,
        `SELECT key, value FROM cursorDiskKV WHERE key LIKE '%${escapedConversationId}%' OR value LIKE '%${escapedConversationId}%' LIMIT 10;`
      );
      composerSummaryRows = await querySqliteRows(
        stateDbPath,
        "SELECT key, length(value) AS valueLength FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData') LIMIT 5;"
      );
    } catch (error) {
      if (isExecFileTimeoutError(error)) {
        continue;
      }
      throw error;
    }

    if (
      matchedItemTableRows.length > 0 ||
      matchedCursorDiskRows.length > 0 ||
      composerSummaryRows.length > 0
    ) {
      return {
        stateDbPath,
        extraction:
          matchedItemTableRows.length > 0 || matchedCursorDiskRows.length > 0
            ? "state-db-match"
            : "state-db-unmatched",
        matchedItemTableRows: matchedItemTableRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        matchedCursorDiskRows: matchedCursorDiskRows.map((row) => ({
          key: String(row.key ?? ""),
          value: coerceSqliteValue(row.value),
        })),
        composerSummaryRows: composerSummaryRows.map((row) => ({
          key: String(row.key ?? ""),
          valueLength: Number(row.valueLength ?? 0),
        })),
      };
    }
  }

  return undefined;
}

export async function buildSidebarMetadataSnapshot(
  conversationState: ExportConversationState,
  exportedAt: string
): Promise<Record<string, unknown>> {
  const summary = summarizeTranscriptForSidebar(
    conversationState.primaryTranscriptContent,
    conversationState.conversationId
  );
  const evidence = await extractSidebarStateEvidence(conversationState.conversationId);

  const composerIds = collectComposerIdsForConversation(conversationState);
  let composerHeadersRestore: unknown;
  let composerDataRestore: unknown;
  if (evidence?.stateDbPath) {
    try {
      const headerRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1;"
      );
      const headerRaw = headerRows[0]?.value;
      if (headerRaw != null) {
        const fullHeadersParsed = parseFullComposerHeadersValue(headerRaw);
        if (fullHeadersParsed) {
          const filtered = filterComposerHeadersByIds(fullHeadersParsed, composerIds);
          if (filtered.allComposers.length > 0) {
            composerHeadersRestore = filtered;
          }
        }
      }
      const dataRows = await querySqliteRows(
        evidence.stateDbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1;"
      );
      const dataRaw = dataRows[0]?.value;
      if (dataRaw != null) {
        const parsedComposerData = parseFullJsonValue(dataRaw);
        if (parsedComposerData && typeof parsedComposerData === "object" && !Array.isArray(parsedComposerData)) {
          composerDataRestore = filterComposerDataPayload(parsedComposerData, composerIds);
        }
      }
    } catch (error) {
      if (!isExecFileTimeoutError(error)) {
        throw error;
      }
    }
  }
  const fallbackComposerHeaders = buildFallbackComposerHeadersPayload(
    conversationState.conversationId,
    summary,
    exportedAt
  );
  const composerHeadersPayload =
    composerHeadersRestore && typeof composerHeadersRestore === "object"
      ? (composerHeadersRestore as Record<string, unknown>)
      : fallbackComposerHeaders;

  return {
    schemaVersion: 1,
    snapshotType: "cursor-sidebar-metadata",
    exportedAt,
    projectKey: conversationState.projectKey,
    conversationId: conversationState.conversationId,
    title: summary.title,
    subtitle: summary.subtitle,
    previewText: summary.previewText,
    messageCount: summary.messageCount,
    participants: summary.participants,
    lastUpdatedAt: summary.lastUpdatedAt ?? conversationState.lastUpdatedAt ?? exportedAt,
    transcriptRelativePaths: [...conversationState.transcriptRelativePaths].sort(),
    storeSnapshotIncluded: Boolean(conversationState.storeArtifact),
    sourceWorkspaceKey: conversationState.sourceWorkspaceKey ?? null,
    extraction: evidence?.extraction ?? "derived-only",
    stateDbPath: evidence?.stateDbPath ?? null,
    matchedItemTableRows: evidence?.matchedItemTableRows ?? [],
    matchedCursorDiskRows: evidence?.matchedCursorDiskRows ?? [],
    composerSummaryRows: evidence?.composerSummaryRows ?? [],
    composerHeaders: composerHeadersPayload,
    composerHeadersRestore: composerHeadersRestore ?? null,
    composerData: composerDataRestore ?? null,
    composerDataRestore: composerDataRestore ?? null,
    warnings: [...conversationState.warnings].sort(),
  };
}

async function resolveSidebarImportStateDbPaths(
  parsed: Record<string, unknown>
): Promise<{ paths: string[]; usedFallback: boolean }> {
  const sp = parsed.stateDbPath;
  if (typeof sp === "string" && sp.length > 0) {
    try {
      await fs.access(sp);
      return { paths: [sp], usedFallback: false };
    } catch {
      const candidates = await resolveImportMergeStateDbCandidates();
      if (candidates.length > 0) {
        return { paths: [candidates[0]!], usedFallback: true };
      }
      return { paths: [], usedFallback: false };
    }
  }
  const candidates = await resolveImportMergeStateDbCandidates();
  return { paths: candidates.length > 0 ? [candidates[0]!] : [], usedFallback: false };
}

export async function applySidebarStateRestoration(
  context: vscode.ExtensionContext,
  sidebarOps: RestoreOperation[],
  logger: ReturnType<typeof getLogger>,
  options?: { scheduleDelayedWriteback?: boolean }
): Promise<StateRestoreOutcome> {
  const outcome: StateRestoreOutcome = {
    stateDbMerged: 0,
    stateDbSkippedNoPayload: 0,
    stateDbSkippedNoDb: 0,
    statePartial: false,
    warnings: [],
  };

  type Agg = {
    headerPayloads: Array<Record<string, unknown>>;
    dataPayloads: Array<Record<string, unknown>>;
    conversationIds: string[];
  };
  const byDb = new Map<string, Agg>();

  for (const op of sidebarOps) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(op.content.toString("utf-8")) as Record<string, unknown>;
    } catch {
      outcome.warnings.push(`Sidebar ${op.conversationId ?? "?"}: invalid JSON; state.vscdb unchanged.`);
      outcome.statePartial = true;
      continue;
    }

    const headersPayload = extractComposerHeadersPayload(parsed);
    const effectiveHeadersPayload =
      headersPayload ?? deriveComposerHeadersPayloadFromSidebarSnapshot(parsed);
    const dataPayload = extractComposerDataPayload(parsed);
    if (!effectiveHeadersPayload && !dataPayload) {
      outcome.stateDbSkippedNoPayload += 1;
      continue;
    }

    const { paths, usedFallback } = await resolveSidebarImportStateDbPaths(parsed);
    if (paths.length === 0) {
      outcome.stateDbSkippedNoDb += 1;
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: state.vscdb not found; only sidebar JSON was written.`
      );
      outcome.statePartial = true;
      continue;
    }

    if (typeof parsed.stateDbPath === "string" && parsed.stateDbPath.length > 0 && usedFallback) {
      outcome.warnings.push(
        `Sidebar ${op.conversationId ?? "?"}: exported stateDbPath unavailable; used default state.vscdb (partial).`
      );
      outcome.statePartial = true;
    }

    const dbPath = paths[0]!;
    const agg = byDb.get(dbPath) ?? {
      headerPayloads: [],
      dataPayloads: [],
      conversationIds: [],
    };
    if (effectiveHeadersPayload) {
      const stamped = stampWorkspaceIdentifierOnPayload(effectiveHeadersPayload);
      agg.headerPayloads.push(stamped);
    }
    if (dataPayload) {
      agg.dataPayloads.push(dataPayload);
    }
    if (op.conversationId) {
      agg.conversationIds.push(op.conversationId);
    }
    byDb.set(dbPath, agg);
  }

  const delayedWritebackTargets: Array<{
    dbPath: string;
    mergedHeadersJson: string;
    mergedDataJson: string | null;
    agg: Agg;
  }> = [];

  for (const [dbPath, agg] of byDb) {
    let existingHeadersRaw: string | undefined;
    let existingDataRaw: string | undefined;
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData');"
      );
      for (const row of rows) {
        const key = String(row.key ?? "");
        const value = row.value;
        if (key === "composer.composerHeaders") {
          if (typeof value === "string") {
            existingHeadersRaw = value;
          } else if (value != null && typeof value === "object") {
            existingHeadersRaw = JSON.stringify(value);
          }
        }
        if (key === "composer.composerData") {
          if (typeof value === "string") {
            existingDataRaw = value;
          } else if (value != null && typeof value === "object") {
            existingDataRaw = JSON.stringify(value);
          }
        }
      }
    } catch (error) {
      outcome.warnings.push(
        isExecFileTimeoutError(error)
          ? `State DB ${dbPath}: SQLite timed out (database may be locked); merge skipped.`
          : `State DB ${dbPath}: read failed; merge skipped.`
      );
      outcome.statePartial = true;
      continue;
    }

    const mergedHeaders = mergeComposerHeadersChain(existingHeadersRaw, agg.headerPayloads);
    const mergedHeadersJson = JSON.stringify(mergedHeaders);
    const mergedData = mergeComposerDataAdditive(existingDataRaw, agg.dataPayloads);
    const mergedDataJson = JSON.stringify(mergedData);

    const { entries: backupEntries } = await createBackup(context, [dbPath]);
    try {
      const escapedHeaders = escapeSqlLiteral(mergedHeadersJson);
      const headerScript =
        `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';\n` +
        `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n`;
      const dataScript =
        agg.dataPayloads.length > 0
          ? (() => {
              const escapedData = escapeSqlLiteral(mergedDataJson);
              return (
                `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';\n` +
                `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');\n`
              );
            })()
          : "";
      const script = `BEGIN IMMEDIATE;\n${headerScript}${dataScript}COMMIT;\n`;
      await runSqliteScript(dbPath, script);
      outcome.stateDbMerged += 1;
      logger.appendLine(
        `[${new Date().toISOString()}] Merged composer state in ${dbPath} for ${agg.conversationIds.join(",")}`
      );

      if (options?.scheduleDelayedWriteback) {
        delayedWritebackTargets.push({
          dbPath,
          mergedHeadersJson,
          mergedDataJson: agg.dataPayloads.length > 0 ? mergedDataJson : null,
          agg,
        });
      }
    } catch (error) {
      await rollbackFromBackup(backupEntries);
      outcome.warnings.push(
        `State DB ${dbPath}: write failed (${error instanceof Error ? error.message : String(error)}); rolled back.`
      );
      outcome.statePartial = true;
    }
  }

  if (delayedWritebackTargets.length > 0) {
    const targets = delayedWritebackTargets;
    let completed = false;
    let resolveCompletion: (() => void) | undefined;

    const runWriteback = async () => {
      for (const target of targets) {
        try {
          const escapedHeaders = escapeSqlLiteral(target.mergedHeadersJson);
          const headerScript =
            `UPDATE ItemTable SET value = '${escapedHeaders}' WHERE key = 'composer.composerHeaders';\n` +
            `INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '${escapedHeaders}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');\n`;
          const dataScript = target.mergedDataJson
            ? (() => {
                const escapedData = escapeSqlLiteral(target.mergedDataJson!);
                return (
                  `UPDATE ItemTable SET value = '${escapedData}' WHERE key = 'composer.composerData';\n` +
                  `INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '${escapedData}' WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');\n`
                );
              })()
            : "";
          const script = `BEGIN IMMEDIATE;\n${headerScript}${dataScript}COMMIT;\n`;
          await runSqliteScript(target.dbPath, script);
          logger.appendLine(
            `[${new Date().toISOString()}] Delayed write-back succeeded for ${target.dbPath} (${target.agg.conversationIds.join(",")})`
          );
        } catch (error) {
          logger.appendLine(
            `[${new Date().toISOString()}] Delayed write-back failed for ${target.dbPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };

    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const timer = setTimeout(async () => {
      if (!completed) {
        completed = true;
        await runWriteback();
        resolveCompletion?.();
      }
    }, DELAYED_WRITEBACK_MS);

    outcome.delayedWriteback = {
      timer,
      cancel: () => {
        completed = true;
        clearTimeout(timer);
        resolveCompletion?.();
      },
      complete: async () => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          await runWriteback();
        }
        await completionPromise;
      },
    };
  }

  return outcome;
}

export function resolveArtifactImportPath(
  targetProject: ProjectInfo,
  artifactEntry: TranscriptBundleArtifactEntry,
  workspaceMapping: ReadonlyMap<string, string>
): string {
  if (artifactEntry.kind === "transcript") {
    const relativePath =
      artifactEntry.sourceRelativePath ??
      `${artifactEntry.conversationId}/${path.basename(artifactEntry.conversationId)}.jsonl`;
    return path.join(targetProject.fullPath, "agent-transcripts", ...relativePath.split("/"));
  }

  if (artifactEntry.kind === "store") {
    const swk = artifactEntry.sourceWorkspaceKey;
    const mapped =
      typeof swk === "string" && swk.length > 0 ? workspaceMapping.get(swk) ?? "" : "";
    return path.join(resolveChatsRoot(), mapped, artifactEntry.conversationId, "store.db");
  }

  return path.join(
    targetProject.fullPath,
    "agent-transcripts",
    artifactEntry.conversationId,
    "cursor-sidebar-metadata.json"
  );
}
