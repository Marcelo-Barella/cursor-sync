import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatBundle } from "../src/chat-persistence.js";

const FIXTURE_CID = "43aae2fb-71fc-4e9c-9add-3e995caaaa80";

const { workspaceCtx, fixtureCid } = vi.hoisted(() => {
  const repo = "/tmp/cursor-sync-fixture-repo";
  return {
  fixtureCid: "43aae2fb-71fc-4e9c-9add-3e995caaaa80",
  workspaceCtx: {
    workspaceStorageId: "f038a5d2e2e5594b5e779064d4feac57",
    folderFsPath: repo,
    chatsWorkspaceKey: "573b4babd5b2f206e06d748cd840b177",
    workspaceIdentifier: {
      id: "f038a5d2e2e5594b5e779064d4feac57",
      uri: {
        $mid: 1,
        fsPath: repo,
        _sep: 47,
        external: `file://${repo}`,
        path: repo,
        scheme: "file",
      },
    },
  },
};
});

const headerOnlyBundle: ChatBundle = {
  schemaVersion: 1,
  type: "chat-persistence",
  createdAt: "2026-01-01T00:00:00.000Z",
  conversationId: FIXTURE_CID,
  title: "Test chat",
  subtitle: "",
  previewText: "",
  sidebarSnapshot: {
    composerHeaders: {
      allComposers: [
        {
          composerId: FIXTURE_CID,
          name: "Test chat",
          type: "head",
          unifiedMode: "agent",
          forceMode: "edit",
          createdAt: 1779369862871,
          lastUpdatedAt: 1779369862871,
          lastOpenedAt: 1779369862871,
        },
      ],
    },
  },
  storeSnapshot: null,
  transcriptFiles: [],
};

vi.mock("../src/chat-import-merge.js", () => ({
  mergeSidebarIntoStateDb: vi.fn().mockResolvedValue({ merged: true, warnings: [] }),
  repairComposerDataAfterActivation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/chat-workspace-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat-workspace-context.js")>();
  return {
    ...actual,
    requireWorkspaceContext: vi.fn().mockResolvedValue(workspaceCtx),
    stateDbPathForWorkspaceStorageId: vi
      .fn()
      .mockReturnValue("/tmp/mock-workspace-state.vscdb"),
  };
});

vi.mock("../src/chat-import-activate.js", () => ({
  buildActivationManifest: vi.fn().mockReturnValue({}),
  enrichManifestPartialStateFromDisk: vi.fn().mockResolvedValue(false),
  normalizeActivationManifest: vi.fn().mockReturnValue({
    composerId: fixtureCid,
    partialState: {},
    commandId: "composer.createComposer",
    createComposerOptions: {},
  }),
  runComposerActivation: vi.fn(),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: "/tmp/mock-cursor-user",
    dotCursor: path.join(process.env.HOME ?? "/tmp", ".cursor"),
  }),
}));

describe("chat-import-sidebar-writeback", () => {
  let tempHome: string;
  let globalStateStore: Record<string, unknown>;
  let context: import("vscode").ExtensionContext;
  let flushPendingSidebarWriteback: typeof import("../src/chat-import-sidebar-writeback.js").flushPendingSidebarWriteback;
  let queueSidebarWriteback: typeof import("../src/chat-import-sidebar-writeback.js").queueSidebarWriteback;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-writeback-"));
    process.env.HOME = tempHome;
    vi.resetModules();
    const mod = await import("../src/chat-import-sidebar-writeback.js");
    flushPendingSidebarWriteback = mod.flushPendingSidebarWriteback;
    queueSidebarWriteback = mod.queueSidebarWriteback;
    globalStateStore = {};
    context = {
      globalState: {
        get: <T>(key: string) => globalStateStore[key] as T | undefined,
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            delete globalStateStore[key];
          } else {
            globalStateStore[key] = value;
          }
        },
      },
    } as import("vscode").ExtensionContext;
    vi.clearAllMocks();
    const { mergeSidebarIntoStateDb, repairComposerDataAfterActivation } = await import(
      "../src/chat-import-merge.js"
    );
    vi.mocked(mergeSidebarIntoStateDb).mockResolvedValue({ merged: true, warnings: [] });
    vi.mocked(repairComposerDataAfterActivation).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    delete process.env.HOME;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("retains pending entries when activation fails", async () => {
    const { runComposerActivation } = await import("../src/chat-import-activate.js");
    vi.mocked(runComposerActivation).mockResolvedValue({
      ok: false,
      exitCode: 1,
      stagedOnly: false,
    });

    await queueSidebarWriteback(context, headerOnlyBundle, workspaceCtx, { activate: true });
    const pendingDir = path.join(tempHome, ".cursor", "import-activation", "sidebar-pending");
    const bundlePath = path.join(pendingDir, `${FIXTURE_CID}.json`);
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();

    await flushPendingSidebarWriteback(context);

    const remaining = globalStateStore["cursorSync.pendingSidebarWriteback"] as {
      entries: Array<{ conversationId: string }>;
    };
    expect(remaining.entries).toHaveLength(1);
    expect(remaining.entries[0]!.conversationId).toBe(FIXTURE_CID);
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
  });

  it("requires registered activation during flush (no open-only success)", async () => {
    const { runComposerActivation } = await import("../src/chat-import-activate.js");
    vi.mocked(runComposerActivation).mockResolvedValue({
      ok: false,
      exitCode: 2,
      stagedOnly: true,
    });

    await queueSidebarWriteback(context, headerOnlyBundle, workspaceCtx, { activate: true });

    await flushPendingSidebarWriteback(context);

    expect(runComposerActivation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ acceptOpenWithoutHandle: false })
    );
    const remaining = globalStateStore["cursorSync.pendingSidebarWriteback"] as {
      entries: Array<{ conversationId: string }>;
    };
    expect(remaining.entries).toHaveLength(1);
  });

  it("retains pending entries when workspace merge succeeds but global merge fails", async () => {
    const { mergeSidebarIntoStateDb } = await import("../src/chat-import-merge.js");
    vi.mocked(mergeSidebarIntoStateDb).mockImplementation(async (dbPath: string) => {
      if (dbPath.includes("globalStorage")) {
        return { merged: false, warnings: ["global db locked"] };
      }
      return { merged: true, warnings: [] };
    });

    await queueSidebarWriteback(context, headerOnlyBundle, workspaceCtx);
    const bundlePath = path.join(
      tempHome,
      ".cursor",
      "import-activation",
      "sidebar-pending",
      `${FIXTURE_CID}.json`
    );

    await flushPendingSidebarWriteback(context);

    const remaining = globalStateStore["cursorSync.pendingSidebarWriteback"] as {
      entries: Array<{ conversationId: string }>;
    };
    expect(remaining.entries).toHaveLength(1);
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
  });

  it("retains pending entries when activation succeeds but repair fails", async () => {
    const { runComposerActivation } = await import("../src/chat-import-activate.js");
    const { repairComposerDataAfterActivation } = await import("../src/chat-import-merge.js");
    vi.mocked(runComposerActivation).mockResolvedValue({
      ok: true,
      composerId: FIXTURE_CID,
      exitCode: 0,
      stagedOnly: false,
    });
    vi.mocked(repairComposerDataAfterActivation).mockRejectedValue(new Error("db locked"));

    await queueSidebarWriteback(context, headerOnlyBundle, workspaceCtx, { activate: true });
    const bundlePath = path.join(
      tempHome,
      ".cursor",
      "import-activation",
      "sidebar-pending",
      `${FIXTURE_CID}.json`
    );

    await flushPendingSidebarWriteback(context);

    const remaining = globalStateStore["cursorSync.pendingSidebarWriteback"] as {
      entries: Array<{ conversationId: string }>;
    };
    expect(remaining.entries).toHaveLength(1);
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
  });

  it("clears pending entries and deletes bundle file when activation succeeds", async () => {
    const { runComposerActivation } = await import("../src/chat-import-activate.js");
    vi.mocked(runComposerActivation).mockResolvedValue({
      ok: true,
      composerId: FIXTURE_CID,
      exitCode: 0,
      stagedOnly: false,
    });

    await queueSidebarWriteback(context, headerOnlyBundle, workspaceCtx, { activate: true });
    const bundlePath = path.join(
      tempHome,
      ".cursor",
      "import-activation",
      "sidebar-pending",
      `${FIXTURE_CID}.json`
    );

    const applied = await flushPendingSidebarWriteback(context);

    expect(applied).toBe(true);
    expect(globalStateStore["cursorSync.pendingSidebarWriteback"]).toBeUndefined();
    await expect(fs.access(bundlePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe conversationId when queueing writeback", async () => {
    const unsafeBundle = {
      ...headerOnlyBundle,
      conversationId: "../../../etc/passwd",
    };
    await queueSidebarWriteback(context, unsafeBundle, workspaceCtx);
    expect(globalStateStore["cursorSync.pendingSidebarWriteback"]).toBeUndefined();
    const pendingDir = path.join(tempHome, ".cursor", "import-activation", "sidebar-pending");
    await expect(fs.access(pendingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
