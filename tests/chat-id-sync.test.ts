import { describe, it, expect, vi } from "vitest";

vi.mock("../src/paths.js", async () => {
  const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
  return { ...PATHS_MOCK_USER_LABELS };
});

vi.mock("../src/sync-roots.js", () => ({
  resolveExtensionSyncRoots: () => ({
    cursorUser: "/tmp/cursor-user",
    dotCursor: "/tmp/.cursor",
  }),
}));
import { buildComposerHeaderPayloadsFromSyncChatHistory } from "../src/chat-id-sync.js";
import type { SyncManifestChatHistoryEntry } from "../src/sync-manifest.js";

describe("chat-id-sync", () => {
  it("uses conversation_id as composerId for every pointer", () => {
    const entries: SyncManifestChatHistoryEntry[] = [
      {
        workspace_key: "ws1",
        conversation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        inline: {
          title: "T",
          content: [{ role: "user", content: "hi" }],
          timestamp: 1712345678000,
        },
      },
    ];
    const payloads = buildComposerHeaderPayloadsFromSyncChatHistory(entries);
    const row = payloads[0]?.allComposers as Array<{ composerId?: string }> | undefined;
    expect(row?.[0]?.composerId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});
