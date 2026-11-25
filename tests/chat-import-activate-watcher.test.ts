// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetVscodeCommandsMock,
  __setExecuteCommandImpl,
  __setRegisteredCommands,
  __setWorkspaceFolders,
} from "./__mocks__/vscode.js";
import {
  CREATE_COMPOSER_COMMAND_ID,
  MANIFEST_VERSION,
  buildActivationManifest,
  normalizeActivationManifest,
  stagePendingManifest,
  type ActivationPaths,
} from "../src/chat-import-activate.js";
import {
  activationWorkspaceMatches,
  loadPendingManifest,
  processPendingActivation,
} from "../src/chat-import-activate-watcher.js";
import type { ChatBundle } from "../src/chat-persistence.js";
import type { WorkspaceContext } from "../src/chat-workspace-context.js";

const FIXTURE_REPO = "/tmp/cursor-sync-watcher-repo";
const OTHER_REPO = "/tmp/cursor-sync-watcher-other";
const FIXTURE_CID = "43aae2fb-71fc-4e9c-9add-3e995caaaa80";

const workspaceCtx: WorkspaceContext = {
  workspaceStorageId: "f038a5d2e2e5594b5e779064d4feac57",
  folderFsPath: FIXTURE_REPO,
  chatsWorkspaceKey: "573b4babd5b2f206e06d748cd840b177",
  workspaceIdentifier: {
    id: "f038a5d2e2e5594b5e779064d4feac57",
    uri: {
      $mid: 1,
      fsPath: FIXTURE_REPO,
      _sep: 47,
      external: `file://${FIXTURE_REPO}`,
      path: FIXTURE_REPO,
      scheme: "file",
    },
  },
};

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

function workspaceFolder(uriPath: string): { uri: { fsPath: string } } {
  return { uri: { fsPath: uriPath } };
}

describe("chat-import-activate-watcher", () => {
  let tempHome: string;
  let paths: ActivationPaths;
  const logs: string[] = [];

  beforeEach(async () => {
    __resetVscodeCommandsMock();
    logs.length = 0;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-watcher-"));
    paths = {
      activationDir: path.join(tempHome, ".cursor", "import-activation"),
      pendingPath: path.join(tempHome, ".cursor", "import-activation", "pending.json"),
      resultPath: path.join(tempHome, ".cursor", "import-activation", "result.json"),
    };
    __setWorkspaceFolders([workspaceFolder(FIXTURE_REPO)]);
  });

  afterEach(async () => {
    __resetVscodeCommandsMock();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("activationWorkspaceMatches resolves paths against open folders", () => {
    const folders = [workspaceFolder(FIXTURE_REPO)] as Parameters<
      typeof activationWorkspaceMatches
    >[1];
    expect(activationWorkspaceMatches(FIXTURE_REPO, folders)).toBe(true);
    expect(activationWorkspaceMatches(`${FIXTURE_REPO}/`, folders)).toBe(true);
    expect(activationWorkspaceMatches(OTHER_REPO, folders)).toBe(false);
    expect(activationWorkspaceMatches(FIXTURE_REPO, undefined)).toBe(false);
  });

  it("loadPendingManifest reads staged pending.json", async () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    await stagePendingManifest(manifest, paths);

    const loaded = await loadPendingManifest(paths);
    expect(loaded?.composerId).toBe(FIXTURE_CID);
    expect(loaded?.version).toBe(MANIFEST_VERSION);
    expect(loaded?.workspaceFolder).toBe(FIXTURE_REPO);
  });

  it("processPendingActivation skips when workspace folder is not open", async () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    await stagePendingManifest(manifest, paths);
    __setWorkspaceFolders([workspaceFolder(OTHER_REPO)]);

    await processPendingActivation({ paths, log: (m) => logs.push(m) });

    expect(logs.some((l) => l.includes("no matching open workspace"))).toBe(true);
    await expect(fs.access(paths.pendingPath)).resolves.toBeUndefined();
  });

  it("processPendingActivation runs createComposer and clears pending on success", async () => {
    __setRegisteredCommands([CREATE_COMPOSER_COMMAND_ID]);
    __setExecuteCommandImpl(async () => ({ composerId: FIXTURE_CID }));

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as unknown as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as unknown as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];
    await stagePendingManifest(manifest, paths);

    await processPendingActivation({ paths, log: (m) => logs.push(m) });

    expect(logs.some((l) => l.includes("processing pending.json"))).toBe(true);
    expect(logs.some((l) => l.includes("Activation OK"))).toBe(true);
    await expect(fs.access(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = JSON.parse(
      await fs.readFile(paths.resultPath, "utf8")
    ) as { ok: boolean; composerId: string };
    expect(result).toEqual({ ok: true, composerId: FIXTURE_CID });
  });

  it("processPendingActivation archives pending when activation is unavailable", async () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    await stagePendingManifest(manifest, paths);

    await processPendingActivation({ paths, log: (m) => logs.push(m) });

    await expect(fs.access(paths.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${paths.pendingPath}.failed`)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("archived pending manifest"))).toBe(true);
    await expect(fs.access(paths.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
