// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const querySqliteRowsMock = vi.fn();
const listGlobalStateVscdbPathsMock = vi.fn();
const buildChatsKeyToFolderMapMock = vi.fn();
const scanWorkspaceStorageForIdMock = vi.fn();

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
  },
}));

vi.mock("../src/transcripts-sqlite.js", () => ({
  listGlobalStateVscdbPaths: () => listGlobalStateVscdbPathsMock(),
}));

vi.mock("../src/chat-workspace-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-workspace-context.js")>();
  return {
    ...actual,
    buildChatsKeyToFolderMap: (...args: unknown[]) => buildChatsKeyToFolderMapMock(...args),
    scanWorkspaceStorageForFolder: (...args: unknown[]) => scanWorkspaceStorageForIdMock(...args),
  };
});

describe("resolveComposerConversationTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    listGlobalStateVscdbPathsMock.mockResolvedValue([]);
    buildChatsKeyToFolderMapMock.mockResolvedValue(new Map());
  });

  it("prefers workspace headers over transcript snippet", async () => {
    const wk = "wk-md5";
    const convId = "conv-a";
    buildChatsKeyToFolderMapMock.mockResolvedValue(
      new Map([[wk, "/home/user/proj"]])
    );
    scanWorkspaceStorageForIdMock.mockResolvedValue("ws-storage-1");
    querySqliteRowsMock.mockImplementation(async (dbPath: string) => {
      if (dbPath.includes("workspaceStorage/ws-storage-1")) {
        return [
          {
            value: JSON.stringify({
              allComposers: [{ composerId: convId, name: "Sidebar Name", type: "head" }],
            }),
          },
        ];
      }
      return [];
    });

    const { resolveComposerConversationTitle } = await import("../src/composer-title.js");
    const title = await resolveComposerConversationTitle({
      conversationId: convId,
      chatsWorkspaceKey: wk,
      transcriptContent: JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "[REDACTED]" }] } }),
    });
    expect(title).toBe("Sidebar Name");
  });

  it("uses global headers when workspace has no row", async () => {
    const convId = "conv-b";
    buildChatsKeyToFolderMapMock.mockResolvedValue(new Map([["wk-x", "/proj"]]));
    scanWorkspaceStorageForIdMock.mockResolvedValue("ws-1");
    listGlobalStateVscdbPathsMock.mockResolvedValue(["/tmp/global/state.vscdb"]);
    querySqliteRowsMock.mockImplementation(async (dbPath: string) => {
      if (dbPath.includes("global")) {
        return [
          {
            value: JSON.stringify({
              allComposers: [{ composerId: convId, name: "Global Title", type: "head" }],
            }),
          },
        ];
      }
      return [{ value: JSON.stringify({ allComposers: [] }) }];
    });

    const { resolveComposerConversationTitle } = await import("../src/composer-title.js");
    const title = await resolveComposerConversationTitle({
      conversationId: convId,
      chatsWorkspaceKey: "wk-x",
    });
    expect(title).toBe("Global Title");
  });

  it("falls back to transcript then UUID when name empty", async () => {
    const convId = "conv-c";
    const { resolveComposerConversationTitle } = await import("../src/composer-title.js");
    const fromTranscript = await resolveComposerConversationTitle({
      conversationId: convId,
      transcriptContent: [
        JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "Real user question" }] },
        }),
      ].join("\n"),
    });
    expect(fromTranscript).toContain("Real user question");

    const fromId = await resolveComposerConversationTitle({ conversationId: convId });
    expect(fromId).toBe(convId);
  });

  it("collection pick: sidebarSnapshot composerHeaders beats bundle.title", async () => {
    const bundle = {
      conversationId: "conv-d",
      title: "Transcript-derived junk",
      sidebarSnapshot: {
        composerHeaders: {
          allComposers: [{ composerId: "conv-d", name: "From Snapshot", type: "head" }],
        },
      },
    } as ChatBundle;

    const { resolveComposerConversationTitle } = await import("../src/composer-title.js");
    const title = await resolveComposerConversationTitle({
      conversationId: "conv-d",
      bundle,
    });
    expect(title).toBe("From Snapshot");
  });
});
