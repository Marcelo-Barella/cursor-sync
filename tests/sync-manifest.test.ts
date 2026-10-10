import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { parseSyncManifestJson, SYNC_MANIFEST_SCHEMA_VERSION } from "../src/sync-manifest.js";

describe("sync-manifest", () => {
  const lz = path.join(os.tmpdir(), "lz-test");

  it("parses a minimal valid manifest", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "conv-1",
          store_db_file: "payloads/conv1/store.db",
        },
      ],
      metadata_overrides: {
        composer_header_payloads: [{ allComposers: [] }],
      },
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.manifest.chat_history).toHaveLength(1);
    expect(r.manifest.db_template.sqlite_file).toBe("templates/store.db");
  });

  it("rejects path traversal in sqlite_file", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "../../etc/passwd" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "c",
          inline: { title: "t", content: [{ role: "user", content: "x" }], timestamp: 1 },
        },
      ],
      metadata_overrides: {},
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
  });

  it("regression: non-string state SQL is rejected", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "c",
          store_db_file: "payloads/c/store.db",
        },
      ],
      metadata_overrides: { state_vscdb_sql: ["SELECT 1", 2] },
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
  });

  it("regression: non-object composer header payload is rejected", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "c",
          store_db_file: "payloads/c/store.db",
        },
      ],
      metadata_overrides: { composer_header_payloads: ["nope"] },
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
  });

  it("regression: malformed inline message is rejected", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "c",
          inline: { title: "t", content: [{ role: "user" }], timestamp: 1 },
        },
      ],
      metadata_overrides: {},
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
  });
});
