import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import type { ChatBundle } from "../src/chat-persistence.js";
import type { WorkspaceIdentifier } from "../src/chat-workspace-context.js";
import {
  PARTIAL_STATE_STRIPPED,
  bundleToPartialState,
  decodeStoreDbIndex,
  sidebarSnapshotHasComposerData,
} from "../src/chat-partial-state.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testsDir, "fixtures", "chat-partial-state");

interface GoldenFixture {
  conversationId: string;
  workspaceIdentifier: WorkspaceIdentifier;
  partialHeaderOnly: Record<string, unknown>;
  partialFull: Record<string, unknown>;
  storeIndex: { meta: Record<string, unknown>; blobCount: number; error?: string };
  sidebarHasComposerDataHeaderOnly: boolean;
  sidebarHasComposerDataFull: boolean;
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf-8")) as T;
}

describe("chat-partial-state", () => {
  const golden = loadJson<GoldenFixture>("golden-python.json");
  const headerOnlyBundle = loadJson<ChatBundle>("header-only-bundle.json");
  const fullBundle = loadJson<ChatBundle>("full-bundle.json");
  const workspaceIdentifier = loadJson<WorkspaceIdentifier>("workspace-identifier.json");
  const cid = golden.conversationId;
  const fixedNowMs = 1780685000000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("PARTIAL_STATE_STRIPPED matches Python frozenset", () => {
    expect([...PARTIAL_STATE_STRIPPED].sort()).toEqual([
      "agentSessionId",
      "capabilities",
      "conversationActionManager",
    ]);
  });

  it("bundleToPartialState header-only matches Python golden", () => {
    const partial = bundleToPartialState(headerOnlyBundle, cid, {
      workspaceIdentifier,
    });
    expect(partial).toEqual({
      ...golden.partialHeaderOnly,
      createdAt: fixedNowMs,
      lastUpdatedAt: fixedNowMs,
      lastOpenedAt: fixedNowMs,
      workspaceIdentifier,
    });
    expect(partial).not.toHaveProperty("conversationMap");
    expect(partial).not.toHaveProperty("fullConversationHeadersOnly");
    expect(partial).not.toHaveProperty("agentSessionId");
  });

  it("bundleToPartialState full sidebar merges rich blob and strips runtime fields", () => {
    const partial = bundleToPartialState(fullBundle, cid, {
      workspaceIdentifier,
    });
    expect(partial).toEqual({
      ...golden.partialFull,
      name: fullBundle.title,
      createdAt: fixedNowMs,
      lastUpdatedAt: fixedNowMs,
      lastOpenedAt: fixedNowMs,
      workspaceIdentifier,
    });
    expect(partial.conversationMap).toEqual({ b1: { id: "b1" } });
    expect(partial.fullConversationHeadersOnly).toEqual([{ bubbleId: "b1", type: 1 }]);
    expect(partial.conversationState).toBe("encrypted-placeholder");
    expect(partial.hasLoaded).toBe(true);
    expect(partial.status).toBe("completed");
    expect(partial).not.toHaveProperty("agentSessionId");
    expect(partial).not.toHaveProperty("capabilities");
    expect(partial).not.toHaveProperty("conversationActionManager");
    expect(partial.requestId).toBe("");
  });

  it("bundleToPartialState keeps destination workspace after source blob merge", () => {
    const sourceWorkspaceIdentifier = {
      id: "source-workspace",
      uri: { fsPath: "/source" },
    };
    const bundle = {
      ...fullBundle,
      sidebarSnapshot: {
        ...(fullBundle.sidebarSnapshot as unknown as Record<string, unknown>),
        composerData: {
          [cid]: {
            ...(((fullBundle.sidebarSnapshot as unknown as Record<string, unknown>).composerData as unknown as Record<string, unknown>)[cid] as unknown as Record<string, unknown>),
            workspaceIdentifier: sourceWorkspaceIdentifier,
          },
        },
      },
    };
    const partial = bundleToPartialState(bundle, cid, {
      workspaceIdentifier,
    });
    expect(partial.workspaceIdentifier).toEqual(workspaceIdentifier);
    expect(partial.name).toBe(fullBundle.title);
    expect(partial.createdAt).toBe(fixedNowMs);
    expect(partial.lastUpdatedAt).toBe(fixedNowMs);
    expect(partial.lastOpenedAt).toBe(fixedNowMs);
  });

  it("sidebarSnapshotHasComposerData matches Python", () => {
    expect(sidebarSnapshotHasComposerData(headerOnlyBundle, cid)).toBe(
      golden.sidebarHasComposerDataHeaderOnly
    );
    expect(sidebarSnapshotHasComposerData(fullBundle, cid)).toBe(
      golden.sidebarHasComposerDataFull
    );
  });

  it("decodeStoreDbIndex matches Python store index", async () => {
    const b64 = readFileSync(path.join(fixtureDir, "store.db.b64"), "utf-8").trim();
    const storeRaw = Buffer.from(b64, "base64");
    const index = await decodeStoreDbIndex(storeRaw);
    expect(index.blobCount).toBe(golden.storeIndex.blobCount);
    expect(index.meta).toEqual(golden.storeIndex.meta);
    const metaRow = index.meta["0"];
    expect(metaRow).toBeTruthy();
    expect(metaRow).toMatchObject({
      agentId: "ff80027c-12b6-4fe5-bb1a-e4d88bd2db05",
      latestRootBlobId: "root-blob-1",
    });
  });
});
