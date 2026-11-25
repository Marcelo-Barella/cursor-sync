// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  parseChatsManifestJson,
  manifestToHeaderPayloads,
  CHATS_MANIFEST_SCHEMA_VERSION,
} from "../src/chats-manifest.js";

const validUuid = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

describe("chats-manifest", () => {
  it("parses a valid global manifest", () => {
    const raw = JSON.stringify({
      schemaVersion: CHATS_MANIFEST_SCHEMA_VERSION,
      stateTarget: "global",
      workspaceKey: "my-workspace",
      chats: [
        {
          chat_id: validUuid,
          title: "Hello",
          content: [{ role: "user", content: "Hi" }],
          timestamp: 1712345678000,
        },
      ],
    });
    const r = parseChatsManifestJson(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.manifest.stateTarget).toBe("global");
    expect(r.manifest.workspaceKey).toBe("my-workspace");
    expect(r.manifest.chats).toHaveLength(1);
    const payloads = manifestToHeaderPayloads(r.manifest);
    expect(payloads[0]?.allComposers?.[0]?.composerId).toBe(validUuid);
  });

  it("rejects invalid schema version", () => {
    const r = parseChatsManifestJson(
      JSON.stringify({
        schemaVersion: 99,
        stateTarget: "global",
        workspaceKey: "w",
        chats: [
          {
            chat_id: validUuid,
            title: "t",
            content: [{ role: "user", content: "x" }],
            timestamp: 1,
          },
        ],
      })
    );
    expect(r.ok).toBe(false);
  });

  it("requires workspaceStorageFolderId for workspace target", () => {
    const r = parseChatsManifestJson(
      JSON.stringify({
        schemaVersion: CHATS_MANIFEST_SCHEMA_VERSION,
        stateTarget: "workspace",
        workspaceKey: "w",
        chats: [
          {
            chat_id: validUuid,
            title: "t",
            content: [{ role: "user", content: "x" }],
            timestamp: 1,
          },
        ],
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("workspaceStorageFolderId"))).toBe(true);
    }
  });
});
