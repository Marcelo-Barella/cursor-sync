import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const env = vi.hoisted(() => ({
  home: "",
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  activeTabInput: undefined as unknown,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => env.home };
});

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return {
    ...base,
    workspace: {
      ...base.workspace,
      get workspaceFolders() {
        return env.workspaceFolders.length > 0 ? env.workspaceFolders : undefined;
      },
    },
    window: {
      ...base.window,
      tabGroups: {
        activeTabGroup: {
          get activeTab() {
            return env.activeTabInput === undefined
              ? undefined
              : { input: env.activeTabInput };
          },
        },
      },
    },
  };
});

const CHAT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_CHAT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function createStore(workspaceKey: string, conversationId: string): Promise<void> {
  const storeDir = path.join(env.home, ".cursor", "chats", workspaceKey, conversationId);
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, "store.db"), "sqlite");
}

async function createTranscript(
  conversationId: string,
  projectKey = "test-project"
): Promise<void> {
  const dir = path.join(
    env.home,
    ".cursor",
    "projects",
    projectKey,
    "agent-transcripts",
    conversationId
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${conversationId}.jsonl`), '{"role":"user"}\n');
}

describe("chat-editor-target", () => {
  beforeEach(async () => {
    env.home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-chat-target-"));
    process.env.HOME = env.home;
    env.workspaceFolders = [];
    env.activeTabInput = undefined;
    vi.resetModules();
  });

  it("extracts a raw UUID string", async () => {
    const { extractConversationIdFromTarget } = await import("../src/chat-editor-target.js");
    expect(extractConversationIdFromTarget(CHAT_ID)).toBe(CHAT_ID);
  });

  it("extracts the UUID final path segment from a Uri-like object", async () => {
    const { extractConversationIdFromTarget } = await import("../src/chat-editor-target.js");
    expect(extractConversationIdFromTarget({ path: `/composer/${CHAT_ID}` })).toBe(CHAT_ID);
  });

  it("rejects non-chat file paths", async () => {
    const { extractConversationIdFromTarget } = await import("../src/chat-editor-target.js");
    expect(extractConversationIdFromTarget("/tmp/project/src/index.ts")).toBeNull();
  });

  it("prefers the current workspace key when the store exists there", async () => {
    const { md5FolderKey } = await import("../src/chat-workspace-context.js");
    const folder = path.join(env.home, "repo-a");
    const currentWorkspaceKey = md5FolderKey(path.resolve(folder));
    env.workspaceFolders = [{ uri: { fsPath: folder } }];
    await createStore("other-workspace", CHAT_ID);
    await createStore(currentWorkspaceKey, CHAT_ID);

    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(CHAT_ID)).resolves.toEqual({
      ok: true,
      target: { conversationId: CHAT_ID, workspaceKey: currentWorkspaceKey },
    });
  });

  it("uses the only matching workspace when current workspace has no store", async () => {
    await createStore("only-workspace", CHAT_ID);
    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(`/chat/${CHAT_ID}`)).resolves.toEqual({
      ok: true,
      target: { conversationId: CHAT_ID, workspaceKey: "only-workspace" },
    });
  });

  it("returns store-not-found when no workspace has the chat store", async () => {
    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(CHAT_ID)).resolves.toEqual({
      ok: false,
      reason: "store-not-found",
      conversationId: CHAT_ID,
    });
  });

  it("falls back to current workspace when transcripts exist without store.db", async () => {
    const { md5FolderKey } = await import("../src/chat-workspace-context.js");
    const folder = path.join(env.home, "repo-a");
    const currentWorkspaceKey = md5FolderKey(path.resolve(folder));
    env.workspaceFolders = [{ uri: { fsPath: folder } }];
    await createTranscript(CHAT_ID);

    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(CHAT_ID)).resolves.toEqual({
      ok: true,
      target: { conversationId: CHAT_ID, workspaceKey: currentWorkspaceKey },
    });
  });

  it("returns ambiguous when multiple non-current workspaces match", async () => {
    await createStore("workspace-a", CHAT_ID);
    await createStore("workspace-b", CHAT_ID);
    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(CHAT_ID)).resolves.toEqual({
      ok: false,
      reason: "ambiguous",
      conversationId: CHAT_ID,
      workspaceKeys: ["workspace-a", "workspace-b"],
    });
  });

  it("falls back to active tab input when command argument is absent", async () => {
    await createStore("tab-workspace", OTHER_CHAT_ID);
    env.activeTabInput = { uri: { path: `/composer/${OTHER_CHAT_ID}` } };
    const { resolveChatEditorExportTarget } = await import("../src/chat-editor-target.js");
    await expect(resolveChatEditorExportTarget(undefined)).resolves.toEqual({
      ok: true,
      target: { conversationId: OTHER_CHAT_ID, workspaceKey: "tab-workspace" },
    });
  });
});
