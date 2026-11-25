import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_MANIFEST_SCHEMA_VERSION } from "../src/sync-manifest.js";
import type { SyncRoots } from "../src/paths.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const listGlobalStateVscdbPathsMock = vi.hoisted(() =>
  vi.fn<() => Promise<string[]>>().mockResolvedValue([])
);

vi.mock("../src/transcripts-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transcripts-sqlite.js")>();
  return {
    ...actual,
    listGlobalStateVscdbPaths: listGlobalStateVscdbPathsMock,
  };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...actual,
    resolveSyncRoots: () => syncRoots,
  };
});

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const templatePath = path.join(repoRoot, "resources", "golden-chat-store.template.db");

let syncRoots: SyncRoots;

async function initItemTableStateDb(dbPath: string): Promise<void> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const script = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute(
  "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)"
)
conn.commit()
conn.close()
`;
  await execFileAsync("python3", ["-c", script, dbPath], { maxBuffer: 1024 * 1024 });
}

const CHAT_CASES: Array<{ title: string; content: string }> = [
  { title: "My notes; part 2", content: "body" },
  { title: "please attach the file", content: "x" },
  { title: "how to detach a branch", content: "git" },
  { title: "robot vacuum review", content: "y" },
  {
    title: "use edit( and readfile( in docs",
    content: "see edit( and readfile( examples",
  },
  { title: "it's; attach'd", content: "nested '; attach" },
  { title: "emoji 🚀", content: "line1\nline2\r\nline3" },
  {
    title: "big",
    content: `${"x".repeat(10_000)}; attach\nVACUUM`,
  },
];

describe("SyncEngine.prepare with chat literals in SQL", () => {
  let tmpRoot = "";
  let landingZone = "";
  let globalStorage = "";
  let globalStateDb = "";

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-engine-sql-"));
    landingZone = path.join(tmpRoot, "landing");
    globalStorage = path.join(tmpRoot, "globalStorage");
    const dotCursor = path.join(tmpRoot, ".cursor");
    syncRoots = {
      cursorUser: path.join(tmpRoot, "cursor-user"),
      dotCursor,
    };
    await fs.mkdir(path.join(dotCursor, "chats", "wk1"), { recursive: true });
    await fs.mkdir(landingZone, { recursive: true });
    await fs.mkdir(path.join(landingZone, "templates"), { recursive: true });
    await fs.copyFile(templatePath, path.join(landingZone, "templates", "store.db"));

    globalStateDb = path.join(syncRoots.cursorUser, "globalStorage", "state.vscdb");
    await initItemTableStateDb(globalStateDb);
    listGlobalStateVscdbPathsMock.mockReset();
    listGlobalStateVscdbPathsMock.mockResolvedValue([globalStateDb]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  for (const { title, content } of CHAT_CASES) {
    it(`prepare succeeds for title/content: ${title.slice(0, 40)}`, async () => {
      const conversationId = crypto.randomUUID();
      const manifest = {
        schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
        state_target: "global",
        workspace_key: "wk1",
        db_template: { sqlite_file: "templates/store.db" },
        chat_history: [
          {
            workspace_key: "wk1",
            conversation_id: conversationId,
            inline: {
              title,
              content: [{ role: "user", content }],
              timestamp: 1_700_000_000_000,
            },
          },
        ],
        metadata_overrides: {},
      };
      await fs.writeFile(
        path.join(landingZone, "sync-manifest.json"),
        JSON.stringify(manifest),
        "utf8"
      );

      const { SyncEngine } = await import("../src/sync-engine.js");
      const engine = new SyncEngine(landingZone);
      const result = await engine.prepare({
        globalStorageFsPath: globalStorage,
        bundledGoldenTemplatePath: templatePath,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.errors.join("; "));
      }
    });
  }
});
