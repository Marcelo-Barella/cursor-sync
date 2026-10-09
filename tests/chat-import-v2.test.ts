// @ts-nocheck
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  computeArtifactChecksum,
  encodeTranscriptArtifact,
} from "../src/transcript-bundle.js";
import { md5FolderKey } from "../src/chat-workspace-context.js";
import type { ChatBundle } from "../src/chat-persistence.js";
import {
  runDiskAndActivationVerify,
  verifyChecksAllOk,
} from "../src/chat-import-verify.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const templatePath = path.join(repoRoot, "resources", "golden-chat-store.template.db");
const mergeBundleFixture = path.join(
  __dirname,
  "fixtures",
  "chat-import-merge",
  "bundle.json"
);

const FIXTURE_REPO = "/tmp/cursor-sync-fixture-repo";
const WS_STORAGE_ID = "f038a5d2e2e5594b5e779064d4feac57";
const CHATS_KEY = "573b4babd5b2f206e06d748cd840b177";

const mockWorkspaceFolders = vi.hoisted(() => {
  const repo = "/tmp/cursor-sync-fixture-repo";
  return [
  {
    uri: { fsPath: repo, scheme: "file" },
    name: "fixture",
    index: 0,
  },
];
});

vi.mock("vscode", async () => {
  const base = await import("./__mocks__/vscode.js");
  return {
    ...base,
    workspace: {
      ...base.workspace,
      get workspaceFolders() {
        return mockWorkspaceFolders;
      },
    },
  };
});

vi.mock("../src/rollback.js", () => ({
  createBackup: vi.fn(async () => ({ backupDir: "", entries: [] })),
  rollbackFromBackup: vi.fn(async () => {}),
  pruneOldBackups: vi.fn(async () => {}),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
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
    const { decodeTranscriptArtifact } = await import("../src/transcript-bundle.js");
    const { md5FolderKey, requireWorkspaceContext } = await import("../src/chat-workspace-context.js");
    const { mergeSidebarIntoStateDb, mergeTargetsForImport } = await import("../src/chat-import-merge.js");

    const bundleRaw = await fsMod.readFile(opts.bundlePath, "utf8");
    const bundle = JSON.parse(bundleRaw) as import("../src/chat-persistence.js").ChatBundle;

    if (!opts.dryRun) {
      if (bundle.storeSnapshot) {
        const chatsKey = md5FolderKey(pathMod.resolve(opts.workspaceFolder));
        const storeDir = pathMod.join(
          process.env.HOME!,
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

      const projectsRoot = pathMod.join(process.env.HOME!, ".cursor", "projects");
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

function pathToFileUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}

async function initEmptyStateVscdb(dbPath: string): Promise<void> {
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

async function setupCursorHomeLayout(homeRoot: string): Promise<{
  cursorUser: string;
  globalStateDb: string;
  workspaceStateDb: string;
}> {
  const cursorUser = path.join(homeRoot, ".config", "Cursor", "User");
  const globalStateDb = path.join(cursorUser, "globalStorage", "state.vscdb");
  const wsDir = path.join(cursorUser, "workspaceStorage", WS_STORAGE_ID);
  const workspaceStateDb = path.join(wsDir, "state.vscdb");

  await fs.mkdir(path.join(cursorUser, "globalStorage"), { recursive: true });
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(path.join(homeRoot, ".cursor", "chats"), { recursive: true });
  await fs.mkdir(FIXTURE_REPO, { recursive: true });

  await fs.writeFile(
    path.join(wsDir, "workspace.json"),
    JSON.stringify({ folder: pathToFileUri(FIXTURE_REPO) }),
    "utf8"
  );

  await initEmptyStateVscdb(globalStateDb);
  await initEmptyStateVscdb(workspaceStateDb);

  return { cursorUser, globalStateDb, workspaceStateDb };
}

async function runSqliteScriptViaPython(dbPath: string, script: string): Promise<void> {
  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-import-v2-sql-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`
  );
  await fs.writeFile(tmpPath, script, "utf8");
  const pyScript = [
    "import sqlite3, sys",
    "conn = sqlite3.connect(sys.argv[1])",
    "conn.executescript(open(sys.argv[2], encoding='utf-8').read())",
    "conn.commit()",
    "conn.close()",
  ].join("\n");
  try {
    await execFileAsync("python3", ["-c", pyScript, dbPath, tmpPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

function loadMergeBundleFixture(): ChatBundle {
  return JSON.parse(readFileSync(mergeBundleFixture, "utf8")) as ChatBundle;
}

async function buildGoldenBundleWithStore(): Promise<ChatBundle> {
  const base = loadMergeBundleFixture();
  const { hydrateGoldenStoreTemplate, chatManifestFromBundle } = await import(
    "../src/store-template-hydrate.js"
  );
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cursor-sync-import-v2-store-")
  );
  const storePath = path.join(outDir, "store.db");
  try {
    await hydrateGoldenStoreTemplate({
      templatePath,
      outputPath: storePath,
      chat: chatManifestFromBundle(base),
    });
    const storeBytes = await fs.readFile(storePath);
    const encoded = encodeTranscriptArtifact(storeBytes, true);
    return {
      ...base,
      storeSnapshot: {
        content: encoded.content,
        encoding: encoded.encoding,
        checksum: computeArtifactChecksum(storeBytes),
        sizeBytes: storeBytes.length,
        sourceWorkspaceKey: "must-not-use-this-key",
      },
    };
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

describe("chat-import-v2 integration", () => {
  let tempHome: string;
  let savedHome: string | undefined;
  let savedXdg: string | undefined;
  let layout: Awaited<ReturnType<typeof setupCursorHomeLayout>>;

  beforeAll(async () => {
    const { __chatPersistenceInternals } = await import("../src/transcripts.js");
    vi.spyOn(__chatPersistenceInternals, "runSqliteScript").mockImplementation(
      runSqliteScriptViaPython
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-import-v2-"));
    savedHome = process.env.HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = tempHome;
    delete process.env.XDG_CONFIG_HOME;

    layout = await setupCursorHomeLayout(tempHome);
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({
      uri: { fsPath: FIXTURE_REPO, scheme: "file" },
      name: "fixture",
      index: 0,
    });
  });

  afterEach(async () => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("imports golden ChatBundle into temp HOME and passes disk verify", async () => {
    const bundle = await buildGoldenBundleWithStore();
    const conversationId = bundle.conversationId;

    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      globalState: {
        get: () => undefined,
        update: async () => {},
      },
    } as unknown as import("vscode").ExtensionContext;

    const result = await restoreChatBundle(context, bundle, { report: () => {} }, {
      workspaceFolder: FIXTURE_REPO,
      syncGlobal: true,
    });

    expect(result.storeWritten).toBe(true);
    expect(result.storeWorkspaceKey).toBe(CHATS_KEY);
    expect(result.sidebarMerged).toBe(true);
    expect(CHATS_KEY).toBe(md5FolderKey(path.resolve(FIXTURE_REPO)));

    const storePath = path.join(
      tempHome,
      ".cursor",
      "chats",
      CHATS_KEY,
      conversationId,
      "store.db"
    );
    const writtenStore = await fs.readFile(storePath);
    expect(writtenStore.length).toBeGreaterThan(0);
    expect(writtenStore.subarray(0, 15).toString("ascii")).toBe("SQLite format 3");

    const { __chatPersistenceInternals } = await import("../src/transcripts.js");
    const blobRows = await __chatPersistenceInternals.querySqliteRows(
      storePath,
      "SELECT COUNT(*) AS n FROM blobs"
    );
    const blobCount = Number(blobRows[0]?.n ?? 0);
    expect(blobCount).toBeGreaterThan(0);

    expect(result.verifyChecks).toBeDefined();
    expect(verifyChecksAllOk(result.verifyChecks!)).toBe(true);
    const failChecks = result.verifyChecks!.filter((c) => c.status === "FAIL");
    expect(failChecks).toEqual([]);

    const storeCheck = result.verifyChecks!.find((c) => c.name === "store.db");
    expect(storeCheck?.status).toBe("OK");

    const globalHeaders = result.verifyChecks!.find(
      (c) => c.name === "global.composerHeaders"
    );
    expect(globalHeaders?.status).toBe("OK");

    const globalData = result.verifyChecks!.find(
      (c) => c.name === `global.composerData[${conversationId}]`
    );
    expect(globalData?.status).toBe("OK");

    const headerRows = await __chatPersistenceInternals.querySqliteRows(
      layout.globalStateDb,
      "SELECT value FROM ItemTable WHERE key='composer.composerHeaders' LIMIT 1"
    );
    const raw = headerRows[0]?.value;
    const parsed =
      typeof raw === "string"
        ? (JSON.parse(raw) as unknown as Record<string, unknown>)
        : (raw as unknown as Record<string, unknown>);
    const row = (parsed.allComposers as Array<Record<string, unknown>>).find(
      (c) => c.composerId === conversationId
    );
    expect(row?.workspaceIdentifier).toMatchObject({
      id: WS_STORAGE_ID,
      uri: { fsPath: path.resolve(FIXTURE_REPO) },
    });
    expect(layout.globalStateDb.startsWith(tempHome)).toBe(true);
  });

  it("runDiskAndActivationVerify passes after restore without real Cursor state.vscdb", async () => {
    const bundle = await buildGoldenBundleWithStore();
    const conversationId = bundle.conversationId;

    const { restoreChatBundle } = await import("../src/chat-persistence.js");
    const { requireWorkspaceContext: requireCtx } = await import(
      "../src/chat-workspace-context.js"
    );

    const context = {
      globalStorageUri: { fsPath: path.join(tempHome, "global-storage") },
      globalState: {
        get: () => undefined,
        update: async () => {},
      },
    } as unknown as import("vscode").ExtensionContext;

    await restoreChatBundle(context, bundle, { report: () => {} }, {
      workspaceFolder: FIXTURE_REPO,
    });

    const wsCtx = await requireCtx({ workspaceFolder: FIXTURE_REPO });
    expect(wsCtx.workspaceStorageId).toBe(WS_STORAGE_ID);
    expect(wsCtx.chatsWorkspaceKey).toBe(CHATS_KEY);

    const checks = await runDiskAndActivationVerify(conversationId, wsCtx, {
      bundle,
      postActivate: false,
    });

    expect(verifyChecksAllOk(checks)).toBe(true);
    expect(checks.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(checks.find((c) => c.name === "store.db")?.status).toBe("OK");

    const globalDb = path.join(layout.cursorUser, "globalStorage", "state.vscdb");
    const workspaceDb = layout.workspaceStateDb;
    expect(globalDb.startsWith(tempHome)).toBe(true);
    expect(workspaceDb.startsWith(tempHome)).toBe(true);
    await expect(fs.stat(globalDb)).resolves.toBeDefined();
    await expect(fs.stat(workspaceDb)).resolves.toBeDefined();
  });

});
