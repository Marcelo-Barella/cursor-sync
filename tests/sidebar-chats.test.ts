import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { dispatchSidebarMessage } from "../src/sidebar/messages.js";
import { recordImport } from "../src/sidebar/import-history.js";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T,>(k: string) => store.get(k) as T,
      update: async (k: string, v: unknown) => { store.set(k, v); },
    },
    extensionUri: { fsPath: "/fake/extension" },
    globalStorageUri: { fsPath: "/fake/global-storage" },
  } as any;
}

function mockWebview() {
  return {
    postMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("dispatchSidebarMessage - chats:listImports", () => {
  it("posts chats:imports with empty rows when no history", async () => {
    const ctx = mockContext();
    const wv = mockWebview();
    await dispatchSidebarMessage(ctx, wv, { command: "chats:listImports" });
    expect(wv.postMessage).toHaveBeenCalledOnce();
    const call = wv.postMessage.mock.calls[0]![0];
    expect(call.type).toBe("chats:imports");
    expect(call.rows).toEqual([]);
  });

  it("posts chats:imports with recorded rows", async () => {
    const ctx = mockContext();
    const wv = mockWebview();
    await recordImport(ctx, {
      conversationId: "test-id",
      transcriptsWritten: 3,
      storeWritten: true,
      sidebarMerged: true,
      warnings: 0,
      timestamp: "2026-01-01T00:00:00Z",
    });
    await dispatchSidebarMessage(ctx, wv, { command: "chats:listImports" });
    const call = wv.postMessage.mock.calls[0]![0];
    expect(call.type).toBe("chats:imports");
    expect(call.rows).toHaveLength(1);
    expect(call.rows[0].conversationId).toBe("test-id");
  });
});

describe("dispatchSidebarMessage - chats:clearHistory", () => {
  it("clears history and posts chats:history-cleared", async () => {
    const ctx = mockContext();
    const wv = mockWebview();
    await recordImport(ctx, {
      conversationId: "c1",
      transcriptsWritten: 0,
      storeWritten: false,
      sidebarMerged: false,
      warnings: 0,
      timestamp: "2026-01-01T00:00:00Z",
    });
    await dispatchSidebarMessage(ctx, wv, { command: "chats:clearHistory" });
    expect(wv.postMessage).toHaveBeenCalledOnce();
    const call = wv.postMessage.mock.calls[0]![0];
    expect(call.type).toBe("chats:history-cleared");

    const wv2 = mockWebview();
    await dispatchSidebarMessage(ctx, wv2, { command: "chats:listImports" });
    const call2 = wv2.postMessage.mock.calls[0]![0];
    expect(call2.rows).toHaveLength(0);
  });
});

describe("dispatchSidebarMessage - settings:get", () => {
  it("posts settings:current with configuration values", async () => {
    const ctx = mockContext();
    const wv = mockWebview();
    await dispatchSidebarMessage(ctx, wv, { command: "settings:get" });
    expect(wv.postMessage).toHaveBeenCalledOnce();
    const call = wv.postMessage.mock.calls[0]![0];
    expect(call.type).toBe("settings:current");
    expect(call.values).toBeDefined();
    expect(typeof call.values.activateDefault).toBe("boolean");
    expect(typeof call.values.activateStrict).toBe("boolean");
    expect(typeof call.values.bridgeWaitResultSeconds).toBe("number");
    expect(typeof call.values.autoReloadAfterImport).toBe("boolean");
    expect(typeof call.values.pythonPath).toBe("string");
    expect(call.values.appearanceTheme).toBe("system");
  });
});

describe("dispatchSidebarMessage - chats:listLocal", () => {
  it("posts chats:recent with empty rows when no workspace folders", async () => {
    const ctx = mockContext();
    const wv = mockWebview();
    await dispatchSidebarMessage(ctx, wv, { command: "chats:listLocal" });
    expect(wv.postMessage).toHaveBeenCalledOnce();
    const call = wv.postMessage.mock.calls[0]![0];
    expect(call.type).toBe("chats:recent");
    expect(call.rows).toEqual([]);
  });
});
