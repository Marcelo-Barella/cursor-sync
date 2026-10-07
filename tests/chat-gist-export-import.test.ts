import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
} from "../src/transcript-bundle.js";
import type { ChatBundle } from "../src/chat-persistence.js";

const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";
const CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json";

const {
  createGistMock,
  getGistMock,
  requireTokenMock,
  getTokenMock,
  withRetryMock,
  appendLineMock,
  showInformationMessageMock,
  showWarningMessageMock,
  showErrorMessageMock,
  showInputBoxMock,
  showQuickPickMock,
  clipboardWriteTextMock,
  requireChatEncryptionPasswordMock,
  encryptChatGistPayloadMock,
  decryptChatGistPayloadMock,
  isEncryptedChatGistPayloadMock,
} = vi.hoisted(() => ({
  createGistMock: vi.fn(),
  getGistMock: vi.fn(),
  requireTokenMock: vi.fn(),
  getTokenMock: vi.fn(),
  withRetryMock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  appendLineMock: vi.fn(),
  showInformationMessageMock: vi.fn(),
  showWarningMessageMock: vi.fn(),
  showErrorMessageMock: vi.fn(),
  showInputBoxMock: vi.fn(),
  showQuickPickMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  requireChatEncryptionPasswordMock: vi.fn(),
  encryptChatGistPayloadMock: vi.fn(),
  decryptChatGistPayloadMock: vi.fn(),
  isEncryptedChatGistPayloadMock: vi.fn(),
}));

let mockedHomeDir = "";
let mockWorkspaceFolder = "";

function folderToProjectKey(folderFsPath: string): string {
  return path.resolve(folderFsPath).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
}

const mockRunDiskAndActivationVerify = vi.hoisted(() =>
  vi.fn(async () => [{ name: "store.db", status: "OK" as const, detail: "mock ok" }])
);

const configurationValues: Record<string, unknown> = {
  "transcripts.autoReloadAfterImport": false,
  "chatImport.activateDefault": false,
  "chatImport.activateStrict": false,
  "chatImport.bridgeWaitResultSeconds": 0,
  "chatImport.pingServer": false,
  "chatGist.encrypt": false,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir,
  };
});

vi.mock("../src/chat-import-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-import-verify.js")>();
  return {
    ...actual,
    runDiskAndActivationVerify: mockRunDiskAndActivationVerify,
  };
});

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: T): void {
      for (const l of this.listeners) l(data);
    }
    dispose(): void {}
  },
  workspace: {
    get workspaceFolders() {
      return [
        {
          uri: { fsPath: mockWorkspaceFolder, scheme: "file" },
          name: "workspace",
          index: 0,
        },
      ];
    },
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
      update: vi.fn(),
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: appendLineMock,
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
    showErrorMessage: showErrorMessageMock,
    showInputBox: showInputBoxMock,
    showQuickPick: showQuickPickMock,
    withProgress: async (
      _options: unknown,
      task: (progress: { report: (value: { message?: string; increment?: number }) => void }) => Promise<unknown>
    ) => task({ report: vi.fn() }),
  },
  env: {
    clipboard: {
      writeText: clipboardWriteTextMock,
    },
  },
  commands: {
    executeCommand: vi.fn(),
  },
  ProgressLocation: {
    Notification: 15,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));

vi.mock("../src/gist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gist.js")>();
  return {
    ...actual,
    GistClient: class {
      createGist = createGistMock;
      getGist = getGistMock;
    },
  };
});

vi.mock("../src/auth.js", () => ({
  requireToken: requireTokenMock,
  getToken: getTokenMock,
}));

vi.mock("../src/retry.js", () => ({
  withRetry: withRetryMock,
}));

vi.mock("../src/chat-encryption-auth.js", () => ({
  requireChatEncryptionPassword: requireChatEncryptionPasswordMock,
  isChatGistEncryptionEnabled: vi.fn(() => configurationValues["chatGist.encrypt"] !== false),
  setChatEncryptionPassword: vi.fn(async () => {}),
  clearChatEncryptionPassword: vi.fn(async () => {}),
}));

vi.mock("../src/chat-gist-crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-gist-crypto.js")>();
  return {
    encryptChatGistPayload: encryptChatGistPayloadMock,
    decryptChatGistPayload: decryptChatGistPayloadMock,
    isEncryptedChatGistPayload: isEncryptedChatGistPayloadMock,
    ChatGistCryptoError: actual.ChatGistCryptoError,
  };
});

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/chat-transport-scripts.js", () => ({
  resolveTransportChatScript: vi.fn(async () => "/fake/cursor_chat_io.py"),
  runPythonDiskImport: vi.fn(async (opts: {
    bundlePath: string;
    workspaceFolder: string;
    targetProject?: string;
    stateDbPath?: string;
    dryRun?: boolean;
    syncGlobal?: boolean;
    pinRecent?: boolean;
  }) => {
    const fsMod = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const osMod = await import("node:os");
    const { decodeTranscriptArtifact } = await import("../src/transcript-bundle.js");
    const { md5FolderKey, requireWorkspaceContext } = await import("../src/chat-workspace-context.js");
    const { mergeSidebarIntoStateDb, mergeTargetsForImport } = await import("../src/chat-import-merge.js");

    const home = osMod.homedir();
    const bundleRaw = await fsMod.readFile(opts.bundlePath, "utf8");
    const bundle = JSON.parse(bundleRaw) as import("../src/chat-persistence.js").ChatBundle;

    if (!opts.dryRun) {
      if (bundle.storeSnapshot) {
        const chatsKey = md5FolderKey(pathMod.resolve(opts.workspaceFolder));
        const storeDir = pathMod.join(
          home,
          ".cursor",
          "chats",
          chatsKey,
          bundle.conversationId
        );
        await fsMod.mkdir(storeDir, { recursive: true });
        const decoded = decodeTranscriptArtifact(
          bundle.storeSnapshot.content,
          bundle.storeSnapshot.encoding
        );
        await fsMod.writeFile(pathMod.join(storeDir, "store.db"), decoded);
      }

      const projectsRoot = pathMod.join(home, ".cursor", "projects");
      for (const tf of bundle.transcriptFiles) {
        const decoded = decodeTranscriptArtifact(tf.content, tf.encoding);
        const targetPath = pathMod.join(projectsRoot, tf.relativePath);
        await fsMod.mkdir(pathMod.dirname(targetPath), { recursive: true });
        await fsMod.writeFile(targetPath, decoded);
      }

      if (bundle.sidebarSnapshot && opts.stateDbPath) {
        const wsCtx = await requireWorkspaceContext({ workspaceFolder: opts.workspaceFolder });
        const targets = await mergeTargetsForImport(opts.stateDbPath, opts.syncGlobal ?? true);
        for (const dbPath of targets) {
          await mergeSidebarIntoStateDb(
            dbPath,
            bundle,
            wsCtx.workspaceIdentifier as unknown as import("../src/chat-import-merge.js").WorkspaceIdentifier,
            { pinRecent: opts.pinRecent ?? true }
          );
        }
      }
    }

    return { ok: true, exitCode: 0, stdout: "", stderr: "" };
  }),
}));

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const transcriptFixture = readFileSync(
  path.join(testsDir, "fixtures", "transcripts-bundle-v2", "conversation.jsonl"),
  "utf-8"
);

function buildChatBundleFixture(options: {
  conversationId: string;
  projectKey: string;
  transcriptContent?: string;
  type?: string;
  schemaVersion?: number;
}): ChatBundle {
  const {
    conversationId,
    projectKey,
    transcriptContent = transcriptFixture,
    type = "chat-persistence",
    schemaVersion = 1,
  } = options;
  const contentBuf = Buffer.from(transcriptContent);
  const encoded = encodeTranscriptArtifact(contentBuf);
  const checksum = computeArtifactChecksum(contentBuf);

  return {
    schemaVersion: schemaVersion as 1,
    type: type as "chat-persistence",
    createdAt: "2026-05-20T12:00:00.000Z",
    conversationId,
    title: "Test Chat",
    subtitle: "1 file",
    previewText: "Test Chat",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [
      {
        relativePath: `${projectKey}/agent-transcripts/${conversationId}/${conversationId}.jsonl`,
        content: encoded.content,
        encoding: encoded.encoding,
        checksum,
        sizeBytes: contentBuf.length,
      },
    ],
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockExportPicker(workspaceKey: string, conversationIds: string[]) {
  showQuickPickMock.mockResolvedValueOnce(
    conversationIds.map((id) => ({ description: id, label: id }))
  );
}

async function setupExportConversation(
  root: string,
  workspaceKey: string,
  conversationId: string,
  options?: { projectKey?: string; transcriptContent?: string }
): Promise<void> {
  await fs.mkdir(
    path.join(root, ".cursor", "chats", workspaceKey, conversationId),
    { recursive: true }
  );
  await fs.writeFile(
    path.join(root, ".cursor", "chats", workspaceKey, conversationId, "store.db"),
    "sqlite",
    "utf-8"
  );
  if (options?.projectKey) {
    const transcriptPath = path.join(
      root,
      ".cursor",
      "projects",
      options.projectKey,
      "agent-transcripts",
      conversationId,
      `${conversationId}.jsonl`
    );
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, options.transcriptContent ?? transcriptFixture, "utf-8");
  }
}

describe("chat gist export and import", () => {
  let tmpRoot: string;
  let extensionContext: {
    globalStorageUri: { fsPath: string };
    globalState: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-chat-gist-"));
    mockedHomeDir = tmpRoot;
    process.env.HOME = tmpRoot;
    mockWorkspaceFolder = path.join(tmpRoot, "workspace-repo");
    await fs.mkdir(mockWorkspaceFolder, { recursive: true });
    mockRunDiskAndActivationVerify.mockReset();
    mockRunDiskAndActivationVerify.mockResolvedValue([
      { name: "store.db", status: "OK", detail: "mock ok" },
    ]);
    createGistMock.mockReset();
    getGistMock.mockReset();
    requireTokenMock.mockReset();
    getTokenMock.mockReset();
    withRetryMock.mockClear();
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    showWarningMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    showInputBoxMock.mockReset();
    showQuickPickMock.mockReset();
    clipboardWriteTextMock.mockReset();
    requireChatEncryptionPasswordMock.mockReset();
    encryptChatGistPayloadMock.mockReset();
    decryptChatGistPayloadMock.mockReset();
    isEncryptedChatGistPayloadMock.mockReset();
    requireChatEncryptionPasswordMock.mockResolvedValue(undefined);
    encryptChatGistPayloadMock.mockImplementation(async (plain: string) => `{"cursorSyncEncrypted":{}}${plain}`);
    isEncryptedChatGistPayloadMock.mockReturnValue(false);
    decryptChatGistPayloadMock.mockImplementation(async (_env: string, _pw: string) => "");
    configurationValues["chatGist.encrypt"] = false;
    configurationValues["transcripts.autoReloadAfterImport"] = false;
    requireTokenMock.mockResolvedValue("ghp_chat_export_token");
    getTokenMock.mockResolvedValue("ghp_chat_import_token");
    extensionContext = {
      globalStorageUri: {
        fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
      },
      globalState: {
        get: vi.fn().mockReturnValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exports chat bundle to private gist with chat-bundle.json only", async () => {
    const workspaceKey = "chat-export-wk";
    const projectKey = "chat-export-project";
    const conversationId = "conv-gist-export-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, {
      projectKey,
    });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue("Copy URL");
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-chat-export",
        html_url: "https://gist.github.com/example/gist-chat-export",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles, description] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    expect(Object.keys(gistFiles)).toEqual([CHAT_BUNDLE_GIST_FILE_NAME]);
    expect(description).toBe("Cursor Sync - Chat Export");
    expect(createGistMock.mock.calls[0]).toHaveLength(2);

    const bundle = JSON.parse(gistFiles[CHAT_BUNDLE_GIST_FILE_NAME].content) as ChatBundle;
    expect(bundle.type).toBe("chat-persistence");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.conversationId).toBe(conversationId);
    expect(bundle.transcriptFiles).toHaveLength(1);
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "https://gist.github.com/example/gist-chat-export"
    );
  });

  it("calls createGist with two arguments only (no public flag)", async () => {
    const workspaceKey = "chat-two-arg-wk";
    const projectKey = "chat-two-arg-project";
    const conversationId = "conv-two-arg-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, {
      projectKey,
    });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-two-arg",
        html_url: "https://gist.github.com/example/gist-two-arg",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    expect(createGistMock.mock.calls[0]).toHaveLength(2);
    expect(createGistMock.mock.calls[0]![2]).toBeUndefined();
  });

  it("imports valid chat bundle and calls restoreChatBundle", async () => {
    const sourceProjectKey = "source-chat-project";
    const conversationId = "conv-gist-import-001";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

    const bundle = buildChatBundleFixture({
      conversationId,
      projectKey: sourceProjectKey,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-chat-import",
        html_url: "https://gist.github.com/example/gist-chat-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: {
            content: JSON.stringify(bundle, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-chat-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) => {
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) {
          return activateItem;
        }
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    const [, restoredBundle, , restoreOptions] = restoreSpy.mock.calls[0]!;
    expect(restoredBundle.conversationId).toBe(conversationId);
    expect(restoreOptions?.workspaceFolder).toBe(mockWorkspaceFolder);
    expect(restoredBundle.type).toBe("chat-persistence");

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      conversationId,
      `${conversationId}.jsonl`
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(
      showWarningMessageMock.mock.calls.some((c) =>
        String(c[0]).includes(`Chat "${conversationId}" loaded.`) &&
          String(c[0]).includes("Text-only Layer 4")
      )
    ).toBe(true);

    restoreSpy.mockRestore();
  });

  it("round-trips export gist bundle through import restore", async () => {
    const workspaceKey = "roundtrip-wk";
    const projectKey = "roundtrip-project";
    const conversationId1 = "conv-roundtrip-001";
    const conversationId2 = "conv-roundtrip-002";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId1, {
      projectKey,
    });
    await setupExportConversation(tmpRoot, workspaceKey, conversationId2, {
      projectKey,
    });

    let exportedCollectionJson = "";
    mockExportPicker(workspaceKey, [conversationId1, conversationId2]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockImplementation(async (gistFiles: Record<string, { content: string }>) => {
      exportedCollectionJson = gistFiles[CHAT_BUNDLES_GIST_FILE_NAME].content;
      return {
        ok: true,
        data: {
          id: "gist-roundtrip",
          html_url: "https://gist.github.com/example/gist-roundtrip",
          description: "Cursor Sync - Chat Export",
          files: {},
          created_at: "2026-05-20T12:00:00.000Z",
          updated_at: "2026-05-20T12:00:00.000Z",
        },
      };
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(exportedCollectionJson).not.toBe("");
    const exportedCollection = JSON.parse(exportedCollectionJson) as {
      type: string;
      bundles: ChatBundle[];
    };
    expect(exportedCollection.type).toBe("chat-bundles-collection");
    expect(exportedCollection.bundles).toHaveLength(2);

    const importTargetKey = folderToProjectKey(mockWorkspaceFolder);
    const importTargetDir = path.join(tmpRoot, ".cursor", "projects", importTargetKey);
    for (const conversationId of [conversationId1, conversationId2]) {
      await fs.rm(
        path.join(
          tmpRoot,
          ".cursor",
          "projects",
          projectKey,
          "agent-transcripts",
          conversationId,
          `${conversationId}.jsonl`
        ),
        { force: true }
      );
    }

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-roundtrip",
        html_url: "https://gist.github.com/example/gist-roundtrip",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: { content: exportedCollectionJson },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValueOnce("https://gist.github.com/user/gist-roundtrip");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          const pickedBundle = items.find((item) => item.description === conversationId1);
          return pickedBundle ? [pickedBundle] : [];
        }
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) {
          return activateItem;
        }
        return items.find((item) => item.description === importTargetKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    const importedPath = path.join(
      importTargetDir,
      "agent-transcripts",
      conversationId1,
      `${conversationId1}.jsonl`
    );
    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    const notImportedPath = path.join(
      importTargetDir,
      "agent-transcripts",
      conversationId2,
      `${conversationId2}.jsonl`
    );
    await expect(fs.access(notImportedPath)).rejects.toThrow();
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });

  it("rejects gist missing chat-bundle.json", async () => {
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-no-bundle",
        html_url: "https://gist.github.com/example/gist-no-bundle",
        description: "empty",
        files: {
          "readme.md": { content: "not a chat export" },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-no-bundle");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Gist chat import failed: Gist does not contain chat-bundle.json. Export a chat with Cursor Sync: Export Chat to Private Gist first."
    );
    restoreSpy.mockRestore();
  });

  it("rejects gist with transcript manifest instead of chat bundle", async () => {
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-transcript-only",
        html_url: "https://gist.github.com/example/gist-transcript-only",
        description: "transcripts",
        files: {
          "transcript-manifest.json": { content: "{}" },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-transcript-only");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Gist chat import failed: Gist does not contain a chat bundle (chat-bundle.json). This Gist is an agent transcript export. Use Cursor Sync: Import Agent Transcripts from Private Gist."
    );
    restoreSpy.mockRestore();
  });

  it("rejects gist with wrong chat bundle type", async () => {
    const bundle = buildChatBundleFixture({
      conversationId: "conv-wrong-type",
      projectKey: "wrong-type-project",
      type: "agent-transcripts",
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-wrong-type",
        html_url: "https://gist.github.com/example/gist-wrong-type",
        description: "wrong",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: JSON.stringify(bundle) },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-wrong-type");

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      'Gist chat import failed: Invalid chat export: expected type "chat-persistence" or "chat-bundles-collection", got "agent-transcripts".'
    );
    restoreSpy.mockRestore();
  });

  it("imports one chat from chat-bundles.json collection gist", async () => {
    const sourceProjectKey = "source-multi-project";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const conv1 = "conv-multi-001";
    const conv2 = "conv-multi-002";
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

    const collection = {
      schemaVersion: 1 as const,
      type: "chat-bundles-collection" as const,
      createdAt: "2026-05-20T12:00:00.000Z",
      sourceWorkspaceKey: "multi-wk",
      bundles: [
        buildChatBundleFixture({ conversationId: conv1, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv2, projectKey: sourceProjectKey }),
      ],
    };

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-multi-import",
        html_url: "https://gist.github.com/example/gist-multi-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: {
            content: JSON.stringify(collection, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-multi-import");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean; picked?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          return items.filter((item) =>
            item.description === conv1 || item.description === conv2
          );
        }
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) return activateItem;
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const executeCommandMock = vi.mocked(
      (await import("vscode")).commands.executeCommand
    );

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(2);
    expect(restoreSpy.mock.calls.map((c) => c[1].conversationId).sort()).toEqual(
      [conv1, conv2].sort()
    );
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(showErrorMessageMock).not.toHaveBeenCalled();

    restoreSpy.mockRestore();
  });

  it("continues batch when second restore fails", async () => {
    const sourceProjectKey = "source-partial-project";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const conv1 = "conv-partial-001";
    const conv2 = "conv-partial-002";
    const conv3 = "conv-partial-003";
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);

    const collection = {
      schemaVersion: 1 as const,
      type: "chat-bundles-collection" as const,
      createdAt: "2026-05-20T12:00:00.000Z",
      sourceWorkspaceKey: "partial-wk",
      bundles: [
        buildChatBundleFixture({ conversationId: conv1, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv2, projectKey: sourceProjectKey }),
        buildChatBundleFixture({ conversationId: conv3, projectKey: sourceProjectKey }),
      ],
    };

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-partial-import",
        html_url: "https://gist.github.com/example/gist-partial-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLES_GIST_FILE_NAME]: {
            content: JSON.stringify(collection, null, 2),
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-partial-import");
    showQuickPickMock.mockImplementation(
      async (
        items: Array<{ description?: string; activate?: boolean }>,
        options?: { canPickMany?: boolean }
      ) => {
        if (options?.canPickMany) {
          return items.filter((item) =>
            [conv1, conv2, conv3].includes(item.description ?? "")
          );
        }
        const activateItem = items.find((item) => item.activate === false);
        if (activateItem) return activateItem;
        return items.find((item) => item.description === targetProjectKey);
      }
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreChatBundle = chatMod.restoreChatBundle;
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");
    restoreSpy.mockImplementation(async (context, bundle, progress, options) => {
      if (bundle.conversationId === conv2) {
        throw new Error("restore failed");
      }
      return restoreChatBundle.call(chatMod, context, bundle, progress, options);
    });

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(restoreSpy).toHaveBeenCalledTimes(3);
    expect(
      showWarningMessageMock.mock.calls.some((c) => /Imported 2\/3/i.test(String(c[0])))
    ).toBe(true);

    const conv1TranscriptPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      conv1,
      `${conv1}.jsonl`
    );
    expect(await fs.readFile(conv1TranscriptPath, "utf-8")).toBe(transcriptFixture);

    restoreSpy.mockRestore();
  });

  it("exports multiple chats to chat-bundles.json", async () => {
    const workspaceKey = "multi-export-wk";
    const id1 = "conv-multi-001";
    const id2 = "conv-multi-002";
    await setupExportConversation(tmpRoot, workspaceKey, id1);
    await setupExportConversation(tmpRoot, workspaceKey, id2);
    mockExportPicker(workspaceKey, [id1, id2]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-multi-export",
        html_url: "https://gist.github.com/example/gist-multi-export",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    expect(Object.keys(gistFiles)).toEqual([CHAT_BUNDLES_GIST_FILE_NAME]);
    const collection = JSON.parse(gistFiles[CHAT_BUNDLES_GIST_FILE_NAME].content) as {
      type: string;
      bundles: unknown[];
    };
    expect(collection.type).toBe("chat-bundles-collection");
    expect(collection.bundles).toHaveLength(2);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("2 chats in private Gist")
      )
    ).toBe(true);
  });

  it("encrypts gist payload when chatGist.encrypt is true", async () => {
    configurationValues["chatGist.encrypt"] = true;
    requireChatEncryptionPasswordMock.mockResolvedValue("test-pass");
    encryptChatGistPayloadMock.mockImplementation(async (plain: string) =>
      JSON.stringify({ cursorSyncEncrypted: { mock: true }, plainLen: plain.length })
    );

    const workspaceKey = "enc-export-wk";
    const projectKey = "enc-export-project";
    const conversationId = "conv-enc-export-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, { projectKey });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-enc",
        html_url: "https://gist.github.com/example/gist-enc",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(requireChatEncryptionPasswordMock).toHaveBeenCalledWith(extensionContext, "export");
    expect(encryptChatGistPayloadMock).toHaveBeenCalledTimes(1);
    const uploaded = createGistMock.mock.calls[0]![0] as Record<string, { content: string }>;
    expect(uploaded[CHAT_BUNDLE_GIST_FILE_NAME]!.content).toContain("cursorSyncEncrypted");
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("encrypted") && !String(c[0]).includes("Anyone with the link")
      )
    ).toBe(true);
  });

  it("skips password and encryption when chatGist.encrypt is false", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const workspaceKey = "plain-export-wk";
    const conversationId = "conv-plain-export-001";
    await setupExportConversation(tmpRoot, workspaceKey, conversationId);
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-plain",
        html_url: "https://gist.github.com/example/gist-plain",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(requireChatEncryptionPasswordMock).not.toHaveBeenCalled();
    expect(encryptChatGistPayloadMock).not.toHaveBeenCalled();
    const uploaded = createGistMock.mock.calls[0]![0] as Record<string, { content: string }>;
    const bundle = JSON.parse(uploaded[CHAT_BUNDLE_GIST_FILE_NAME]!.content);
    expect(bundle.type).toBe("chat-persistence");
  });

  it("downloads full gist file when API marks content truncated", async () => {
    const bundle = buildChatBundleFixture({
      conversationId: "conv-truncated-import",
      projectKey: folderToProjectKey(mockWorkspaceFolder),
    });
    const plainJson = JSON.stringify(bundle);
    const originalFetch = globalThis.fetch;

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-truncated",
        html_url: "https://gist.github.com/example/gist-truncated",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: {
            content: plainJson.slice(0, 120),
            truncated: true,
            raw_url: "https://gist.githubusercontent.com/example/raw/chat-bundle.json",
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => plainJson,
    });

    isEncryptedChatGistPayloadMock.mockReturnValue(false);
    showInputBoxMock.mockResolvedValue("gist-truncated");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === folderToProjectKey(mockWorkspaceFolder))
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    try {
      const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
      await executeImportChatFromGist(extensionContext as never);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://gist.githubusercontent.com/example/raw/chat-bundle.json",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("token"),
          }),
        })
      );
      expect(restoreSpy).toHaveBeenCalledTimes(1);
      expect(showErrorMessageMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      restoreSpy.mockRestore();
    }
  });

  it("decrypts encrypted gist on import", async () => {
    const sourceProjectKey = "enc-import-project";
    const conversationId = "conv-enc-import-001";
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const bundle = buildChatBundleFixture({ conversationId, projectKey: sourceProjectKey });
    const plainJson = JSON.stringify(bundle, null, 2);
    const envelopeJson = JSON.stringify({ cursorSyncEncrypted: { v: 1 } });

    isEncryptedChatGistPayloadMock.mockReturnValue(true);
    decryptChatGistPayloadMock.mockResolvedValue(plainJson);
    requireChatEncryptionPasswordMock.mockResolvedValue("import-pass");

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-enc-import",
        html_url: "https://gist.github.com/example/gist-enc-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: envelopeJson },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-enc-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === targetProjectKey)
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(requireChatEncryptionPasswordMock).toHaveBeenCalledWith(
      extensionContext,
      "import-envelope"
    );
    expect(decryptChatGistPayloadMock).toHaveBeenCalledWith(envelopeJson, "import-pass");
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    restoreSpy.mockRestore();
  });

  it("does not require password for plain gist when encrypt setting is false", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const bundle = buildChatBundleFixture({
      conversationId: "conv-plain-import",
      projectKey: "plain-import-project",
    });
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-plain-import",
        html_url: "https://gist.github.com/example/gist-plain-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: JSON.stringify(bundle) },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });
    isEncryptedChatGistPayloadMock.mockReturnValue(false);
    showInputBoxMock.mockResolvedValue("gist-plain-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === folderToProjectKey(mockWorkspaceFolder))
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(requireChatEncryptionPasswordMock).not.toHaveBeenCalled();
    expect(decryptChatGistPayloadMock).not.toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    restoreSpy.mockRestore();
  });

  it("surfaces DECRYPT_FAILED without leaking password", async () => {
    const { ChatGistCryptoError } = await import("../src/chat-gist-crypto.js");
    isEncryptedChatGistPayloadMock.mockReturnValue(true);
    requireChatEncryptionPasswordMock.mockResolvedValue("wrong");
    decryptChatGistPayloadMock.mockRejectedValue(
      new ChatGistCryptoError("Decryption failed.", "DECRYPT_FAILED")
    );
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-bad-pass",
        files: { [CHAT_BUNDLE_GIST_FILE_NAME]: { content: '{"cursorSyncEncrypted":{}}' } },
      },
    });
    showInputBoxMock.mockResolvedValue("gist-bad-pass");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/decrypt|password/i)
    );
    expect(showErrorMessageMock.mock.calls[0]![0]).not.toContain("wrong");
  });
});
