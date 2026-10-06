import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import { mergeComposerDataAdditive } from "../src/composer-merge.js";

const querySqliteRowsMock = vi.hoisted(() => vi.fn());
const runSqliteScriptMock = vi.hoisted(() => vi.fn());

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
    runSqliteScript: (...args: unknown[]) => runSqliteScriptMock(...args),
    listGlobalStateVscdbPaths: vi.fn(),
    resolveStateDbCandidates: vi.fn(),
  },
}));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  composerDataForFocus,
  filterComposerDataForConversation,
  filterComposerHeadersForConversation,
  headersPayloadForImport,
  pinComposerAsMostRecent,
  prepareComposerDataForImport,
  prepareHeadersForImport,
  readRichComposerDataEntryFromStateDb,
  repairComposerDataAfterActivation,
  stampWorkspaceIdentifierOnHeaders,
  rebindComposerRecord,
  type WorkspaceIdentifier,
} from "../src/chat-import-merge.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testsDir, "fixtures", "chat-import-merge");

const FIXED_NOW_MS = 1774872000100;
const EXPECTED_PIN_MS = FIXED_NOW_MS + 1;

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf-8")) as T;
}

function normalizePinTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePinTimestamps);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
      if (k === "createdAt" || k === "lastUpdatedAt" || k === "lastOpenedAt") {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        out[k] = n >= EXPECTED_PIN_MS - 2 && n <= EXPECTED_PIN_MS + 2 ? EXPECTED_PIN_MS : v;
      } else {
        out[k] = normalizePinTimestamps(v);
      }
    }
    return out;
  }
  return value;
}

describe("chat-import-merge", () => {
  const bundle = loadJson<ChatBundle>("bundle.json");
  const workspaceIdentifier = loadJson<WorkspaceIdentifier>("workspace-identifier.json");
  const existingHeaders = loadJson<{ allComposers: Array<Record<string, unknown>> }>("existing-headers.json");
  const existingData = loadJson<Record<string, unknown>>("existing-data.json");
  const golden = loadJson<Record<string, unknown>>("golden-python.json");
  const cid = bundle.conversationId;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filterComposerHeadersForConversation matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const headers = snap.composerHeaders as unknown as Record<string, unknown>;
    const result = filterComposerHeadersForConversation(headers, cid);
    expect(result).toEqual(golden.filterComposerHeadersForConversation);
  });

  it("filterComposerDataForConversation matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const data = snap.composerData as unknown as Record<string, unknown>;
    const result = filterComposerDataForConversation(data, cid);
    expect(result).toEqual(golden.filterComposerDataForConversation);
  });

  it("headersPayloadForImport matches Python golden", () => {
    const result = headersPayloadForImport(bundle);
    expect(result).toEqual(golden.headersPayloadForImport);
  });

  it("pinComposerAsMostRecent bumps target row timestamps", () => {
    const payload = headersPayloadForImport(bundle);
    const result = pinComposerAsMostRecent(payload, cid);
    const row = result.allComposers.find((c) => c.composerId === cid);
    expect(row?.lastUpdatedAt).toBe(EXPECTED_PIN_MS);
    expect(row?.lastOpenedAt).toBe(EXPECTED_PIN_MS);
    expect(normalizePinTimestamps(result)).toEqual(normalizePinTimestamps(golden.pinComposerAsMostRecent));
  });

  it("stampWorkspaceIdentifierOnHeaders stamps only target composerId", () => {
    const payload = headersPayloadForImport(bundle);
    const pinned = pinComposerAsMostRecent(payload, cid);
    const result = stampWorkspaceIdentifierOnHeaders(pinned, cid, workspaceIdentifier);
    const target = result.allComposers.find((c) => c.composerId === cid);
    expect(target?.workspaceIdentifier).toEqual(workspaceIdentifier);
    expect(normalizePinTimestamps(result)).toEqual(
      normalizePinTimestamps(golden.stampWorkspaceIdentifierOnHeaders)
    );
  });

  it("composerDataForFocus then snapshot merge matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const data = snap.composerData as unknown as Record<string, unknown>;
    let merged = composerDataForFocus(cid, JSON.stringify(existingData));
    const extra = filterComposerDataForConversation(data, cid);
    if (Object.keys(extra).length > 0) {
      merged = mergeComposerDataAdditive(JSON.stringify(merged), [extra]);
    }
    expect(merged).toEqual(golden.composerDataForFocus);
  });

  it("prepareComposerDataForImport matches Python golden", () => {
    const result = prepareComposerDataForImport(
      JSON.stringify(existingData),
      bundle,
      cid,
      workspaceIdentifier
    );
    expect(result).toEqual(golden.prepareComposerDataForImport);
  });

  it("prepareHeadersForImport matches Python golden (pin + stamp)", () => {
    const result = prepareHeadersForImport(
      JSON.stringify(existingHeaders),
      bundle,
      cid,
      workspaceIdentifier,
      { pinRecent: true }
    );
    expect(normalizePinTimestamps(result)).toEqual(
      normalizePinTimestamps(golden.prepareHeadersForImport)
    );
  });

  it("rebindComposerRecord clears requestId and stamps workspace", () => {
    const result = rebindComposerRecord(
      {
        composerId: cid,
        requestId: "source-session-request-must-clear",
        workspaceUris: ["/old/path"],
        agentSessionId: "stale",
      },
      workspaceIdentifier
    );
    expect(result.requestId).toBe("");
    expect(result.workspaceUris).toEqual([]);
    expect(result.agentSessionId).toBeUndefined();
    expect(result.workspaceIdentifier).toEqual(workspaceIdentifier);
  });

  it("prepareComposerDataForImport clears requestId from sidebar snapshot blob", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const data = { ...(snap.composerData as unknown as Record<string, unknown>) };
    const row = { ...(data[cid] as unknown as Record<string, unknown>) };
    row.requestId = "stale-request-from-export";
    data[cid] = row;
    const bundleWithRequest = {
      ...bundle,
      sidebarSnapshot: { ...snap, composerData: data },
    };
    const result = prepareComposerDataForImport(
      JSON.stringify(existingData),
      bundleWithRequest,
      cid,
      workspaceIdentifier
    );
    expect((result[cid] as unknown as Record<string, unknown>).requestId).toBe("");
  });

  it("stamp leaves non-target rows workspaceIdentifier unchanged", () => {
    const headers = {
      allComposers: [
        { composerId: cid, name: "A" },
        { composerId: "other", name: "B", workspaceIdentifier: { id: "keep" } },
      ],
    };
    const result = stampWorkspaceIdentifierOnHeaders(headers, cid, workspaceIdentifier);
    expect(result.allComposers[1]?.workspaceIdentifier).toEqual({ id: "keep" });
    expect(result.allComposers[0]?.workspaceIdentifier).toEqual(workspaceIdentifier);
  });

  it("headersPayloadForImport prefers snapshot header name over bundle.title", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const bundleWithConflictingTitle: ChatBundle = {
      ...bundle,
      title: "Transcript junk",
      sidebarSnapshot: {
        ...snap,
        composerHeaders: {
          allComposers: [
            {
              type: "head",
              composerId: cid,
              name: "Header Name",
              lastUpdatedAt: 1710000000000,
            },
          ],
        },
      },
    };
    const result = headersPayloadForImport(bundleWithConflictingTitle);
    expect(result.allComposers[0]?.name).toBe("Header Name");
  });

  it("headersPayloadForImport uses bundle.title when snapshot headers absent", () => {
    const snap = bundle.sidebarSnapshot as unknown as Record<string, unknown>;
    const bundleTitleOnly: ChatBundle = {
      ...bundle,
      title: "Transcript Title",
      sidebarSnapshot: {
        ...snap,
        composerHeaders: { allComposers: [] },
      },
    };
    const result = headersPayloadForImport(bundleTitleOnly);
    expect(result.allComposers[0]?.name).toBe("Transcript Title");
  });
});

describe("readRichComposerDataEntryFromStateDb", () => {
  it("decodes hex-encoded cursorDiskKV BLOB values", async () => {
    const conversationId = "43aae2fb-71fc-4e9c-9add-3e995caaaa80";
    const entry = {
      composerId: conversationId,
      conversationMap: { bubble1: { type: 1 } },
      fullConversationHeadersOnly: [{ bubbleId: "bubble1", type: 1 }],
    };
    const hex = Buffer.from(JSON.stringify(entry), "utf-8").toString("hex");

    querySqliteRowsMock.mockImplementation(async (_dbPath: string, sql: string) => {
      if (sql.includes("cursorDiskKV")) {
        return [{ value: hex }];
      }
      return [];
    });

    const rich = await readRichComposerDataEntryFromStateDb("/tmp/state.vscdb", conversationId);
    expect(rich).toEqual(entry);
  });
});

describe("repairComposerDataAfterActivation", () => {
  it("skips write when partial has no conversation content", async () => {
    await repairComposerDataAfterActivation("/tmp/state.vscdb", "cid", {
      composerId: "cid",
      name: "empty",
    });
    expect(runSqliteScriptMock).not.toHaveBeenCalled();
  });

  it("repairs when partial has inline object conversationState", async () => {
    querySqliteRowsMock.mockResolvedValue([]);
    await repairComposerDataAfterActivation("/tmp/state.vscdb", "cid", {
      composerId: "cid",
      name: "blob-backed",
      conversationState: { turns: [{ role: "user", text: "hi" }] },
    });
    expect(runSqliteScriptMock).toHaveBeenCalled();
  });
});
