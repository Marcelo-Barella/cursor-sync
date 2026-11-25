import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showWarningMessageMock = vi.fn();
const executeCommandMock = vi.fn();

const configurationValues: Record<string, unknown> = {
  "chatImport.activateDefault": false,
  "chatImport.activateStrict": false,
  "chatImport.bridgeWaitResultSeconds": 0,
  "chatImport.pingServer": false,
};

let workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> = [
  { uri: { fsPath: "/repo/a" }, name: "a", index: 0 },
];

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolders;
    },
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
    }),
  },
  window: {
    showQuickPick: showQuickPickMock,
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
  },
  commands: {
    executeCommand: executeCommandMock,
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/chat-import-sidebar-writeback.js", () => ({
  flushPendingSidebarWriteback: vi.fn().mockResolvedValue(false),
}));

const mockExtensionContext = {
  globalState: {
    get: vi.fn(),
    update: vi.fn(),
  },
} as unknown as import("vscode").ExtensionContext;

import type { ChatBundle } from "../src/chat-persistence.js";

const chatBundleFixture: ChatBundle = {
  schemaVersion: 1,
  type: "chat-persistence",
  createdAt: "2026-05-21T00:00:00.000Z",
  conversationId: "conv-1",
  title: "One",
  subtitle: "1 file",
  previewText: "One",
  sidebarSnapshot: null,
  storeSnapshot: null,
  transcriptFiles: [],
};

describe("chat-import-ux", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceFolders = [
      { uri: { fsPath: "/repo/a" }, name: "a", index: 0 },
      { uri: { fsPath: "/repo/b" }, name: "b", index: 1 },
    ];
    configurationValues["chatImport.activateDefault"] = false;
  });

  it("pickImportWorkspaceFolder auto-selects single root", async () => {
    workspaceFolders = [{ uri: { fsPath: "/only/repo" }, name: "only", index: 0 }];
    const { pickImportWorkspaceFolder } = await import("../src/chat-import-ux.js");
    await expect(pickImportWorkspaceFolder()).resolves.toBe("/only/repo");
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("pickImportWorkspaceFolder quick-picks multi-root", async () => {
    showQuickPickMock.mockResolvedValueOnce({
      label: "b",
      description: "/repo/b",
    });
    const { pickImportWorkspaceFolder } = await import("../src/chat-import-ux.js");
    await expect(pickImportWorkspaceFolder()).resolves.toBe("/repo/b");
    expect(showQuickPickMock).toHaveBeenCalledTimes(1);
  });

  it("promptChatImportOptions applies activateDefault then user override", async () => {
    workspaceFolders = [{ uri: { fsPath: "/repo/a" }, name: "a", index: 0 }];
    configurationValues["chatImport.activateDefault"] = true;
    showQuickPickMock.mockResolvedValueOnce({
      label: "Disk restore only",
      activate: false,
    });
    const { promptChatImportOptions } = await import("../src/chat-import-ux.js");
    const result = await promptChatImportOptions();
    expect(result?.workspaceFolder).toBe("/repo/a");
    expect(result?.restoreOptions.activate).toBe(false);
    expect(result?.restoreOptions.workspaceFolder).toBe("/repo/a");
  });

  it("promptChatImportOptions forceActivate skips activate prompt", async () => {
    workspaceFolders = [{ uri: { fsPath: "/repo/a" }, name: "a", index: 0 }];
    const { promptChatImportOptions } = await import("../src/chat-import-ux.js");
    const result = await promptChatImportOptions({ forceActivate: true });
    expect(result?.restoreOptions.activate).toBe(true);
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("formatVerifySummary summarizes check counts", async () => {
    const { formatVerifySummary } = await import("../src/chat-import-ux.js");
    expect(
      formatVerifySummary([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "WARN", detail: "x" },
      ])
    ).toContain("2 checks");
    expect(
      formatVerifySummary([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "WARN", detail: "x" },
      ])
    ).toContain("1 OK");
  });

  it("presentChatImportOutcome does not reload after successful chat import", async () => {
    configurationValues["transcripts.autoReloadAfterImport"] = true;
    const { presentChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentChatImportOutcome(
      mockExtensionContext,
      {
        conversationId: "c1",
        transcriptsWritten: 0,
        storeWritten: false,
        sidebarMerged: false,
        warnings: [],
      },
      { activate: false },
      "chat-load"
    );
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("presentChatImportOutcome does not auto-reload when sidebar merged", async () => {
    configurationValues["transcripts.autoReloadAfterImport"] = true;
    const { presentChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentChatImportOutcome(
      mockExtensionContext,
      {
        conversationId: "c1",
        transcriptsWritten: 1,
        storeWritten: true,
        sidebarMerged: true,
        warnings: [],
      },
      { activate: false },
      "chat-load"
    );
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('Chat "c1" loaded.')
    );
  });

  it("presentChatImportOutcome does not offer Reload Window for chat bundle import", async () => {
    configurationValues["transcripts.autoReloadAfterImport"] = false;
    const { presentChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentChatImportOutcome(
      mockExtensionContext,
      {
        conversationId: "c1",
        transcriptsWritten: 1,
        storeWritten: true,
        sidebarMerged: true,
        warnings: [],
      },
      { activate: false },
      "chat-load"
    );
    expect(showInformationMessageMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Composer sidebar was updated"),
      "Reload Window"
    );
    expect(executeCommandMock).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("buildChatImportResultMessage includes verify summary", async () => {
    const { buildChatImportResultMessage } = await import("../src/chat-import-ux.js");
    const msg = buildChatImportResultMessage(
      {
        conversationId: "c1",
        transcriptsWritten: 1,
        storeWritten: true,
        sidebarMerged: true,
        warnings: [],
        verifyChecks: [{ name: "store.db", status: "OK", detail: "" }],
      },
      { activate: true }
    );
    expect(msg).toContain('Chat "c1" loaded.');
    expect(msg).toContain("verify");
    expect(msg).toContain("activation requested");
  });

  it("restoreChatBundlesBatch continues after failure", async () => {
    const restoreMod = await import("../src/chat-persistence-restore.js");
    const restoreSpy = vi.spyOn(restoreMod, "restoreChatBundle");
    const okResult = {
      conversationId: "conv-ok",
      transcriptsWritten: 1,
      storeWritten: true,
      sidebarMerged: true,
      warnings: [] as string[],
    };
    restoreSpy
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce(okResult);

    const { restoreChatBundlesBatch } = await import("../src/chat-import-ux.js");
    const bundles: ChatBundle[] = [
      { ...chatBundleFixture, conversationId: "conv-fail", title: "Fail Chat" },
      { ...chatBundleFixture, conversationId: "conv-ok", title: "Ok Chat" },
    ];
    const progress = { report: vi.fn() };
    const batch = await restoreChatBundlesBatch(
      {} as never,
      bundles,
      { activate: false, workspaceFolder: "/repo/a" },
      progress,
      "gist-chat-import"
    );

    expect(restoreSpy).toHaveBeenCalledTimes(2);
    expect(batch.successes).toHaveLength(1);
    expect(batch.successes[0]?.conversationId).toBe("conv-ok");
    expect(batch.failures).toHaveLength(1);
    expect(batch.failures[0]?.bundle.conversationId).toBe("conv-fail");
    expect(batch.failures[0]?.error).toContain("first failed");
    expect(progress.report).toHaveBeenCalledWith({
      message: "Importing chat 1/2: Fail Chat...",
    });
    expect(progress.report).toHaveBeenCalledWith({
      message: "Importing chat 2/2: Ok Chat...",
    });

    restoreSpy.mockRestore();
  });

  it("presentBatchChatImportOutcome shows X/Y summary", async () => {
    const { presentBatchChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentBatchChatImportOutcome(
      mockExtensionContext,
      {
        successes: [
          {
            conversationId: "a",
            transcriptsWritten: 0,
            storeWritten: false,
            sidebarMerged: false,
            warnings: [],
          },
          {
            conversationId: "b",
            transcriptsWritten: 0,
            storeWritten: false,
            sidebarMerged: false,
            warnings: [],
          },
        ],
        failures: [],
      },
      { activate: false },
      "gist-chat-import",
      2
    );
    expect(showInformationMessageMock).toHaveBeenCalledWith("Imported 2/2 chats.");
    expect(showWarningMessageMock).not.toHaveBeenCalled();
  });

  it("presentBatchChatImportOutcome warns on partial failure", async () => {
    const { presentBatchChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentBatchChatImportOutcome(
      mockExtensionContext,
      {
        successes: [
          {
            conversationId: "a",
            transcriptsWritten: 0,
            storeWritten: false,
            sidebarMerged: false,
            warnings: [],
          },
        ],
        failures: [
          {
            bundle: { ...chatBundleFixture, conversationId: "b", title: "Broken" },
            error: "boom",
          },
        ],
      },
      { activate: false },
      "gist-chat-import",
      2
    );
    expect(showWarningMessageMock).toHaveBeenCalledWith(
      "Imported 1/2 chats. 1 failed: Broken."
    );
  });

  it("presentBatchChatImportOutcome does not claim restore for verify FAIL without disk writes", async () => {
    const { presentBatchChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentBatchChatImportOutcome(
      mockExtensionContext,
      {
        successes: [
          {
            conversationId: "conv-a",
            transcriptsWritten: 0,
            storeWritten: false,
            sidebarMerged: false,
            warnings: ["Activation verify reported issues."],
            verifyChecks: [
              { name: "activation.result", status: "FAIL", detail: "missing" },
            ],
          },
        ],
        failures: [],
      },
      { activate: false },
      "gist-chat-import",
      1
    );
    expect(showWarningMessageMock).not.toHaveBeenCalledWith(
      expect.stringContaining("restored")
    );
    expect(showInformationMessageMock).toHaveBeenCalledWith("Imported 1/1 chat.");
  });

  it("presentBatchChatImportOutcome warns when disk restored but verify failed", async () => {
    const { presentBatchChatImportOutcome } = await import("../src/chat-import-ux.js");
    await presentBatchChatImportOutcome(
      mockExtensionContext,
      {
        successes: [
          {
            conversationId: "conv-a",
            transcriptsWritten: 0,
            storeWritten: true,
            sidebarMerged: false,
            warnings: [],
            verifyDegraded: true,
            verifyChecks: [
              { name: "global.composerHeaders", status: "FAIL", detail: "missing" },
            ],
          },
        ],
        failures: [],
      },
      { activate: false },
      "gist-chat-import",
      1
    );
    expect(showWarningMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/restored \(store.db\) with verify warnings.*Imported 1\/1 chat/)
    );
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });
});
