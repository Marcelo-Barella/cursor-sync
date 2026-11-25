// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetVscodeCommandsMock,
  __setExecuteCommandImpl,
  __setRegisteredCommands,
} from "./__mocks__/vscode.js";
import type { ChatBundle } from "../src/chat-persistence.js";
import type { WorkspaceContext } from "../src/chat-workspace-context.js";
import {
  COMPOSER_GET_HANDLE_COMMAND_ID,
  COMPOSER_URI_SCHEME,
  CREATE_NEW_COMPOSER_COMMAND_ID,
  CREATE_COMPOSER_COMMAND_ID,
  MANIFEST_VERSION,
  buildActivationManifest,
  composerUriForId,
  normalizeActivationManifest,
  parseComposerIdFromCommandResult,
  runComposerActivation,
  waitForActivationResult,
  stagePendingManifest,
  writeResultJson,
  clearStaleResult,
  type ActivationPaths,
} from "../src/chat-import-activate.js";

const FIXTURE_REPO = "/tmp/cursor-sync-fixture-repo";
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

describe("chat-import-activate", () => {
  let tempHome: string;
  let paths: ActivationPaths;

  beforeEach(async () => {
    __resetVscodeCommandsMock();
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-activate-"));
    paths = {
      activationDir: path.join(tempHome, ".cursor", "import-activation"),
      pendingPath: path.join(tempHome, ".cursor", "import-activation", "pending.json"),
      resultPath: path.join(tempHome, ".cursor", "import-activation", "result.json"),
    };
  });

  afterEach(async () => {
    __resetVscodeCommandsMock();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("buildActivationManifest produces bridge input shape", () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    expect(raw.workspaceFolder).toBe(FIXTURE_REPO);
    expect(raw.openInNewTab).toBe(true);
    expect((raw.partialState as unknown as Record<string, unknown>).composerId).toBe(FIXTURE_CID);
    expect((raw.partialState as unknown as Record<string, unknown>).workspaceIdentifier).toEqual(
      workspaceCtx.workspaceIdentifier
    );
  });

  it("normalizeActivationManifest sets version 1 and commandId", () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const normalized = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    expect(normalized.version).toBe(MANIFEST_VERSION);
    expect(normalized.commandId).toBe(CREATE_COMPOSER_COMMAND_ID);
    expect(normalized.composerId).toBe(FIXTURE_CID);
    expect(normalized.createComposerOptions).toEqual({
      openInNewTab: true,
      view: "editor",
    });
    expect(normalized.stagedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stagePendingManifest writes atomic pending.json", async () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    const pendingPath = await stagePendingManifest(manifest, paths);
    expect(pendingPath).toBe(paths.pendingPath);

    const onDisk = JSON.parse(readFileSync(paths.pendingPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.version).toBe(1);
    expect(onDisk.commandId).toBe("composer.createComposer");
    expect(onDisk.composerId).toBe(FIXTURE_CID);
    expect(await fs.stat(`${paths.pendingPath}.tmp`).catch(() => null)).toBeNull();
  });

  it("writeResultJson and clearStaleResult manage result.json", async () => {
    await writeResultJson(FIXTURE_CID, true, paths);
    const result = JSON.parse(readFileSync(paths.resultPath, "utf8")) as {
      ok: boolean;
      composerId: string;
    };
    expect(result).toEqual({ ok: true, composerId: FIXTURE_CID });

    await clearStaleResult(paths);
    await expect(fs.access(paths.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parseComposerIdFromCommandResult prefers command return value", () => {
    expect(parseComposerIdFromCommandResult("other-id", FIXTURE_CID)).toBe("other-id");
    expect(
      parseComposerIdFromCommandResult({ composerId: "from-object" }, FIXTURE_CID)
    ).toBe("from-object");
    expect(parseComposerIdFromCommandResult(undefined, FIXTURE_CID)).toBe(FIXTURE_CID);
  });

  it("runComposerActivation stages only with exitCode 2 when command missing", async () => {
    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome).toEqual({
      ok: false,
      composerId: FIXTURE_CID,
      exitCode: 2,
      stagedOnly: true,
    });
    expect(readFileSync(paths.pendingPath, "utf8")).toContain(FIXTURE_CID);
    await expect(fs.access(paths.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runComposerActivation writes result.json on executeCommand success", async () => {
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

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome).toEqual({
      ok: true,
      composerId: FIXTURE_CID,
      exitCode: 0,
      stagedOnly: false,
    });
    const result = JSON.parse(readFileSync(paths.resultPath, "utf8")) as {
      ok: boolean;
      composerId: string;
    };
    expect(result).toEqual({ ok: true, composerId: FIXTURE_CID });
  });

  it("runComposerActivation skips composer.createNew when partial state has no conversation content", async () => {
    const executeSpy = vi.fn(async () => undefined);
    __setRegisteredCommands([CREATE_NEW_COMPOSER_COMMAND_ID, "composer.openComposer"]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);

    await runComposerActivation(manifest, { paths, stagePending: false });

    expect(executeSpy).not.toHaveBeenCalledWith(
      CREATE_NEW_COMPOSER_COMMAND_ID,
      expect.anything()
    );
  });

  it("runComposerActivation falls back to createComposer when createNew fails", async () => {
    const executeSpy = vi.fn(async (command: string) => {
      if (command === CREATE_NEW_COMPOSER_COMMAND_ID) {
        throw new Error("createNew rejected");
      }
      return { composerId: FIXTURE_CID };
    });
    __setRegisteredCommands([CREATE_NEW_COMPOSER_COMMAND_ID, CREATE_COMPOSER_COMMAND_ID]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as unknown as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as unknown as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith(
      CREATE_COMPOSER_COMMAND_ID,
      expect.anything(),
      manifest.createComposerOptions
    );
  });

  it("runComposerActivation uses composer.createNew when partial state has conversation content", async () => {
    const executeSpy = vi.fn(async () => undefined);
    __setRegisteredCommands([CREATE_NEW_COMPOSER_COMMAND_ID]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as unknown as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as unknown as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];
    (manifest.partialState as unknown as Record<string, unknown>).conversationState = "~encodedPayload";

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome.ok).toBe(true);
    const createNewCall = executeSpy.mock.calls.find(
      (call) => call[0] === CREATE_NEW_COMPOSER_COMMAND_ID
    );
    expect(createNewCall).toBeDefined();
    const createNewPartial = (createNewCall![1] as unknown as Record<string, unknown>).partialState as Record<
      string,
      unknown
    >;
    expect(createNewPartial.conversationState).toBeUndefined();
    expect(createNewPartial.fullConversationHeadersOnly).toHaveLength(1);
    expect(executeSpy).not.toHaveBeenCalledWith(
      CREATE_COMPOSER_COMMAND_ID,
      expect.anything(),
      expect.anything()
    );
  });

  it("runComposerActivation passes partialState and createComposerOptions to executeCommand", async () => {
    const executeSpy = vi.fn(async () => undefined);
    __setRegisteredCommands([CREATE_COMPOSER_COMMAND_ID]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as unknown as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as unknown as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];

    await runComposerActivation(manifest, { paths });

    expect(executeSpy).toHaveBeenCalledWith(
      CREATE_COMPOSER_COMMAND_ID,
      expect.objectContaining({
        conversationMap: { "bubble-1": { type: 1 } },
        fullConversationHeadersOnly: [{ bubbleId: "bubble-1", type: 1 }],
      }),
      manifest.createComposerOptions
    );
  });

  it("runComposerActivation skips composer.createComposer when partial state has no conversation content", async () => {
    const executeSpy = vi.fn(async () => undefined);
    __setRegisteredCommands([CREATE_COMPOSER_COMMAND_ID, "composer.openComposer"]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);

    await runComposerActivation(manifest, { paths, stagePending: false });

    expect(executeSpy).not.toHaveBeenCalledWith(
      CREATE_COMPOSER_COMMAND_ID,
      expect.anything(),
      expect.anything()
    );
  });

  it("runComposerActivation uses openComposer fallback when createComposer is missing", async () => {
    const { OPEN_COMPOSER_COMMAND_ID } = await import("../src/chat-import-activate.js");
    const executeSpy = vi.fn(async (command: string) => {
      if (command === OPEN_COMPOSER_COMMAND_ID) {
        return undefined;
      }
      if (command === COMPOSER_GET_HANDLE_COMMAND_ID) {
        return { composerId: FIXTURE_CID };
      }
      return undefined;
    });
    __setRegisteredCommands([OPEN_COMPOSER_COMMAND_ID, COMPOSER_GET_HANDLE_COMMAND_ID]);
    __setExecuteCommandImpl(executeSpy);

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome).toEqual({
      ok: true,
      composerId: FIXTURE_CID,
      exitCode: 0,
      stagedOnly: false,
    });
    expect(executeSpy).toHaveBeenCalledWith(
      OPEN_COMPOSER_COMMAND_ID,
      FIXTURE_CID,
      expect.objectContaining({ openInNewTab: true, openExistingOnly: true })
    );
    const result = JSON.parse(readFileSync(paths.resultPath, "utf8")) as {
      ok: boolean;
      composerId: string;
    };
    expect(result).toEqual({ ok: true, composerId: FIXTURE_CID });
  });

  it("composerUriForId uses cursor.composer scheme", () => {
    expect(composerUriForId(FIXTURE_CID).scheme).toBe(COMPOSER_URI_SCHEME);
    expect(composerUriForId(FIXTURE_CID).path).toBe(FIXTURE_CID);
  });

  it("runComposerActivation returns exitCode 1 when executeCommand throws", async () => {
    __setRegisteredCommands([CREATE_COMPOSER_COMMAND_ID]);
    __setExecuteCommandImpl(async () => {
      throw new Error("createComposer rejected");
    });

    const raw = buildActivationManifest(headerOnlyBundle, FIXTURE_CID, workspaceCtx);
    const manifest = normalizeActivationManifest(raw as unknown as Record<string, unknown>);
    (manifest.partialState as unknown as Record<string, unknown>).conversationMap = {
      "bubble-1": { type: 1 },
    };
    (manifest.partialState as unknown as Record<string, unknown>).fullConversationHeadersOnly = [
      { bubbleId: "bubble-1", type: 1 },
    ];

    const outcome = await runComposerActivation(manifest, { paths });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stagedOnly).toBe(false);
    await expect(fs.access(paths.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waitForActivationResult polls until result.json appears", async () => {
    const waitPromise = waitForActivationResult({ paths, timeoutMs: 800, pollIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    await writeResultJson(FIXTURE_CID, true, paths);
    const cid = await waitPromise;
    expect(cid).toBe(FIXTURE_CID);
  });

  it("waitForActivationResult returns null on timeout", async () => {
    const cid = await waitForActivationResult({ paths, timeoutMs: 150, pollIntervalMs: 50 });
    expect(cid).toBeNull();
  });
});
