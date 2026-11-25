import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const testEnv = { home: "" };

const querySqliteRowsMock = vi.hoisted(() => vi.fn());
const resolveStateDbCandidatesMock = vi.hoisted(() => vi.fn());
const listGlobalStateVscdbPathsMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return { ...base };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testEnv.home || actual.homedir(),
  };
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
}));

vi.mock("../src/chat-disk-kv-export.js", () => ({
  enrichBundleWithLiveDiskKv: vi.fn(),
  exportDiskKvSnapshot: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/transcripts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transcripts.js")>();
  return {
    ...actual,
    __chatPersistenceInternals: {
      ...actual.__chatPersistenceInternals,
      querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
      resolveStateDbCandidates: () => resolveStateDbCandidatesMock(),
      listGlobalStateVscdbPaths: () => listGlobalStateVscdbPathsMock(),
      resolveChatsRoot: () => path.join(testEnv.home, ".cursor", "chats"),
    },
  };
});

describe("buildChatBundle export title", () => {
  let tempHome: string;
  const conversationId = "conv-title-export";
  const workspaceKey = "wk-md5";
  const SIDEBAR_TITLE = "Sidebar Title";
  const TRANSCRIPT_JUNK = "Transcript junk snippet";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "chat-bundle-title-"));
    testEnv.home = tempHome;

    const projectKey = "proj-title";
    const transcriptDir = path.join(
      tempHome,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      conversationId
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, `${conversationId}.jsonl`),
      `${JSON.stringify({ role: "user", content: TRANSCRIPT_JUNK })}\n`
    );

    await fs.mkdir(
      path.join(tempHome, ".cursor", "chats", workspaceKey, conversationId),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(tempHome, ".cursor", "chats", workspaceKey, conversationId, "store.db"),
      "fake-store"
    );

    const headers = {
      allComposers: [{ composerId: conversationId, name: SIDEBAR_TITLE, type: "head" }],
    };
    resolveStateDbCandidatesMock.mockResolvedValue(["/fake/state.vscdb"]);
    querySqliteRowsMock.mockResolvedValue([
      { key: "composer.composerHeaders", value: JSON.stringify(headers) },
    ]);
    listGlobalStateVscdbPathsMock.mockResolvedValue([]);

    vi.resetModules();
  });

  afterEach(async () => {
    testEnv.home = "";
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("prefers composer header name over transcript snippet for bundle.title", async () => {
    const { buildChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
    } as unknown as import("vscode").ExtensionContext;

    const { bundle } = await buildChatBundle(context, conversationId, { report: () => {} }, {
      workspaceKey,
    });

    expect(bundle.title).toBe(SIDEBAR_TITLE);
    expect(bundle.previewText).toBe(SIDEBAR_TITLE);

    const composerHeaders = bundle.sidebarSnapshot?.composerHeaders as
      | { allComposers: Array<{ composerId: string; name: string }> }
      | undefined;
    expect(composerHeaders?.allComposers).toHaveLength(1);
    expect(composerHeaders?.allComposers[0]!.composerId).toBe(conversationId);
    expect(composerHeaders?.allComposers[0]!.name).toBe(SIDEBAR_TITLE);
  });
});
