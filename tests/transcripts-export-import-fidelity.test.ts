// @ts-nocheck
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundleArtifactSyncKey,
  encodeTranscriptArtifact,
  syncKeyToGistFileName,
} from "../src/transcript-bundle.js";
import {
  appendLineMock,
  buildManifest,
  buildManifestAmbiguousSharedStoreWorkspace,
  clipboardWriteTextMock,
  configurationValues,
  createGistMock,
  flushMicrotasks,
  getGistMock,
  getTokenMock,
  mockedHomeDir,
  requireTokenMock,
  showErrorMessageMock,
  showInformationMessageMock,
  showInputBoxMock,
  showQuickPickMock,
  showWarningMessageMock,
  sidebarFixture,
  storeFixture,
  transcriptArtifactSyncKey,
  transcriptFixture,
  transcriptGistFileName,
  withRetryMock,
} from "./transcripts-export-import-fidelity-fixtures.js";

describe("transcript export and import fidelity", () => {
  let tmpRoot: string;
  let extensionContext: { globalStorageUri: { fsPath: string } };

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-transcript-fidelity-"));
    mockedHomeDir.current = tmpRoot;
    createGistMock.mockReset();
    getGistMock.mockReset();
    requireTokenMock.mockReset();
    getTokenMock.mockReset();
    withRetryMock.mockClear();
    appendLineMock.mockReset();
    showInformationMessageMock.mockReset();
    showWarningMessageMock.mockReset();
    showErrorMessageMock.mockReset();
    showInputBoxMock.mockReset();
    showQuickPickMock.mockReset();
    clipboardWriteTextMock.mockReset();
    configurationValues["transcripts.enabled"] = true;
    configurationValues["transcripts.maxFileSizeKB"] = 2048;
    requireTokenMock.mockResolvedValue("ghp_export_token");
    getTokenMock.mockResolvedValue("ghp_import_token");
    extensionContext = {
      globalStorageUri: {
        fsPath: path.join(tmpRoot, ".cursor-sync-global-storage"),
      },
    };
    await fs.mkdir(extensionContext.globalStorageUri.fsPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it("exports store-only conversation when agent-transcripts has no jsonl but store.db exists", async () => {
    const projectKey = "store-only-project";
    const convId = "conv-store-only-uuid";
    const chatsRoot = path.join(tmpRoot, ".cursor", "chats", "ws-aaa");
    await fs.mkdir(path.join(chatsRoot, convId), { recursive: true });
    await fs.writeFile(
      path.join(chatsRoot, convId, "store.db"),
      Buffer.from("SQLite format 3\0test-bytes", "utf-8")
    );
    const atDir = path.join(tmpRoot, ".cursor", "projects", projectKey, "agent-transcripts", convId);
    await fs.mkdir(atDir, { recursive: true });

    showQuickPickMock
      .mockImplementationOnce(async (items: Array<{ description?: string }>) =>
        items.filter((item) => item.description === projectKey)
      )
      .mockImplementationOnce(
        async (items: Array<{ conversationKey?: string }>) =>
          items.filter((item) => item.conversationKey === `${projectKey}:${convId}`)
      );
    showWarningMessageMock.mockResolvedValue("Export");
    showInformationMessageMock.mockResolvedValue("Copy URL");
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-store-only",
        html_url: "https://gist.github.com/example/gist-store-only",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {},
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    const { executeExportTranscripts } = await import("../src/transcripts.js");
    await executeExportTranscripts(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    const manifest = JSON.parse(gistFiles["transcript-manifest.json"].content) as {
      schemaVersion: number;
      conversations: Record<
        string,
        { transcriptArtifacts: string[]; storeArtifact?: string; conversationId: string }
      >;
    };
    const conv = manifest.conversations[`${projectKey}:${convId}`];
    expect(conv).toBeDefined();
    expect(conv.transcriptArtifacts).toEqual([]);
    expect(conv.storeArtifact).toBeDefined();
    const storeKey = conv.storeArtifact!;
    expect(manifest.schemaVersion).toBe(2);
    expect(gistFiles[syncKeyToGistFileName(storeKey)]).toBeDefined();
  });

  it("exports exact transcript bytes with a checksum-backed manifest", async () => {
    const projectKey = "source-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const transcriptPath = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      projectKey,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );

    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, transcriptFixture, "utf-8");

    showQuickPickMock
      .mockImplementationOnce(async (items: Array<{ description?: string }>) =>
        items.filter((item) => item.description === projectKey)
      )
      .mockImplementationOnce(
        async (items: Array<{ conversationKey?: string; description?: string }>) =>
          items.filter((item) => item.conversationKey === `${projectKey}:conversation-123`)
      );
    showWarningMessageMock.mockResolvedValue("Export");
    showInformationMessageMock.mockResolvedValue("Copy URL");
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-export",
        html_url: "https://gist.github.com/example/gist-export",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {},
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    const { executeExportTranscripts } = await import("../src/transcripts.js");
    await executeExportTranscripts(extensionContext as never);
    await flushMicrotasks();

    expect(createGistMock).toHaveBeenCalledTimes(1);
    const [gistFiles] = createGistMock.mock.calls[0] as [
      Record<string, { content: string }>,
      string,
    ];
    const transcriptArtifactId = transcriptArtifactSyncKey(projectKey, relativePath);
    const gistFileName = syncKeyToGistFileName(transcriptArtifactId);
    const manifest = JSON.parse(gistFiles["transcript-manifest.json"].content) as {
      schemaVersion: number;
      type: string;
      sourceProjects: Record<string, { fileCount: number }>;
      artifacts: Record<string, { checksum: string; sizeBytes: number; kind: string }>;
    };
    const expectedChecksum = crypto
      .createHash("sha256")
      .update(transcriptFixture)
      .digest("hex");

    expect(gistFiles[gistFileName].content).toBe(transcriptFixture);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.type).toBe("agent-transcripts");
    expect(manifest.sourceProjects[projectKey].fileCount).toBe(1);
    expect(manifest.artifacts[transcriptArtifactId].kind).toBe("transcript");
    expect(manifest.artifacts[transcriptArtifactId].checksum).toBe(expectedChecksum);
    expect(manifest.artifacts[transcriptArtifactId].sizeBytes).toBe(
      Buffer.byteLength(transcriptFixture, "utf-8")
    );
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "https://gist.github.com/example/gist-export"
    );
  });

  it("imports a v2-style bundle while preserving user, assistant, and tool transcript bytes", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      targetProjectKey
    );

    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v2",
        html_url: "https://gist.github.com/example/gist-import-v2",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactSyncKey(sourceProjectKey, relativePath))]: {
            content: transcriptFixture,
          },
          [syncKeyToGistFileName(
            bundleArtifactSyncKey(sourceProjectKey, "conversation-123", "sidebar", "sidebar-metadata.json")
          )]: { content: sidebarFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("abcdefabcdefabcdefab");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);
    showInformationMessageMock.mockImplementation((msg: unknown) => {
      const s = String(msg);
      if (s.includes("Use the Import action")) {
        return Promise.resolve("Import");
      }
      return Promise.resolve(undefined);
    });

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );
    const importedContent = await fs.readFile(importedPath, "utf-8");

    expect(importedContent).toBe(transcriptFixture);
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("Transcript import complete: 2 written")
      )
    ).toBe(true);
  });

  it("imports v2 bundle with store into mapped project chats path and surfaces restore coverage", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);
    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
      includeStore: true,
      storeSourceWorkspaceKey: "unrelated-source-workspace-hash",
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );
    const storeArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "store",
      "store.db"
    );
    const storeBuffer = Buffer.from(storeFixture, "utf-8");
    const storeEncoded = encodeTranscriptArtifact(storeBuffer, true);

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v2-full",
        html_url: "https://gist.github.com/example/gist-import-v2-full",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: { content: transcriptFixture },
          [syncKeyToGistFileName(sidebarArtifactId)]: { content: sidebarFixture },
          [syncKeyToGistFileName(storeArtifactId)]: { content: storeEncoded.content },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("a1b2c3d4e5f6a7b8c9d0e1f2");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);
    showInformationMessageMock.mockImplementation((msg: unknown) => {
      const s = String(msg);
      if (s.includes("Use the Import action")) {
        return Promise.resolve("Import");
      }
      return Promise.resolve(undefined);
    });

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    const expectedTranscriptPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );
    const expectedSidebarPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "cursor-sidebar-metadata.json"
    );
    const expectedStorePath = path.join(
      tmpRoot,
      ".cursor",
      "chats",
      targetProjectKey,
      "conversation-123",
      "store.db"
    );

    expect(await fs.readFile(expectedTranscriptPath, "utf-8")).toBe(transcriptFixture);
    expect(await fs.readFile(expectedSidebarPath, "utf-8")).toBe(sidebarFixture);
    expect(await fs.readFile(expectedStorePath)).toEqual(storeBuffer);
    expect(showErrorMessageMock).not.toHaveBeenCalled();

    const completionMsg = showInformationMessageMock.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Transcript import complete:"));
    expect(completionMsg).toBeDefined();
    expect(completionMsg).toContain("3 written");
  });

  it("keeps schemaVersion 1 transcript imports working", async () => {
    const sourceProjectKey = "legacy-project";
    const targetProjectKey = "legacy-target";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(
      tmpRoot,
      ".cursor",
      "projects",
      targetProjectKey
    );

    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 1,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });

    const storeBuffer = Buffer.from(storeFixture, "utf-8");
    const storeEncoded = encodeTranscriptArtifact(storeBuffer, true);
    const storeArtifactGistName = syncKeyToGistFileName(
      bundleArtifactSyncKey(sourceProjectKey, "conversation-123", "store", "store.db")
    );

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v1",
        html_url: "https://gist.github.com/example/gist-import-v1",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [transcriptGistFileName(sourceProjectKey, relativePath)]: {
            content: transcriptFixture,
          },
          [syncKeyToGistFileName(
            bundleArtifactSyncKey(sourceProjectKey, "conversation-123", "sidebar", "sidebar-metadata.json")
          )]: { content: sidebarFixture },
          [storeArtifactGistName]: { content: storeEncoded.content },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("12345123451234512345");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ description?: string }>) =>
        items.filter(
          (item) =>
            item.description ===
            path.join(targetProjectDir, "agent-transcripts", "conversation-123", "conversation-123.jsonl")
        )
      );
    showInformationMessageMock.mockImplementation((msg: unknown) => {
      const s = String(msg);
      if (s.includes("Use the Import action")) {
        return Promise.resolve("Import");
      }
      return Promise.resolve(undefined);
    });

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    const importedPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "conversation-123.jsonl"
    );
    const expectedSidebarPath = path.join(
      targetProjectDir,
      "agent-transcripts",
      "conversation-123",
      "cursor-sidebar-metadata.json"
    );
    const expectedStorePath = path.join(
      tmpRoot,
      ".cursor",
      "chats",
      targetProjectKey,
      "conversation-123",
      "store.db"
    );

    expect(await fs.readFile(importedPath, "utf-8")).toBe(transcriptFixture);
    expect(await fs.readFile(expectedSidebarPath, "utf-8")).toBe(sidebarFixture);
    expect(await fs.readFile(expectedStorePath)).toEqual(storeBuffer);
    expect(showErrorMessageMock).not.toHaveBeenCalled();

    const completionMsg = showInformationMessageMock.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("Transcript import complete:"));
    expect(completionMsg).toBeDefined();
    expect(completionMsg).toContain("3 written");
  });

  it("fails schemaVersion 1 import on checksum mismatch", async () => {
    const sourceProjectKey = "legacy-project";
    const targetProjectKey = "legacy-target";
    const relativePath = "conversation-123/conversation-123.jsonl";
    const targetProjectDir = path.join(tmpRoot, ".cursor", "projects", targetProjectKey);
    await fs.mkdir(targetProjectDir, { recursive: true });

    const manifest = buildManifest({
      schemaVersion: 1,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-import-v1-bad-sum",
        html_url: "https://gist.github.com/example/gist-import-v1-bad-sum",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [transcriptGistFileName(sourceProjectKey, relativePath)]: {
            content: `${transcriptFixture}\n`,
          },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("deadbeefdeadbeefdead");
    showQuickPickMock.mockImplementationOnce(
      async (items: Array<{ description?: string }>) =>
        items.find((item) => item.description === targetProjectKey)
    );

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Import failed: checksum mismatch for conversation-123/conversation-123.jsonl."
    );
  });

  it("fails v2 preflight when bundle file is missing", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-missing-side",
        html_url: "https://gist.github.com/example/gist-missing-side",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: { content: transcriptFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("0123456789abcdef0123");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Bundle file missing for "${sidebarArtifactId}".`
    );
  });

  it("fails v2 preflight on checksum mismatch", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-bad-v2",
        html_url: "https://gist.github.com/example/gist-bad-v2",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: {
            content: `${transcriptFixture}\n`,
          },
          [syncKeyToGistFileName(sidebarArtifactId)]: { content: sidebarFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("fedcba9876543210fedc");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Checksum mismatch for "${transcriptArtifactId}".`
    );
  });

  it("fails v2 preflight when manifest omits artifact metadata", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );
    const ghostId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "transcript",
      "ghost.jsonl"
    );

    const manifestBroken = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    manifestBroken.conversations[`${sourceProjectKey}:conversation-123`].transcriptArtifacts = [
      transcriptArtifactId,
      ghostId,
    ];

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-bad-meta",
        html_url: "https://gist.github.com/example/gist-bad-meta",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifestBroken, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: { content: transcriptFixture },
          [syncKeyToGistFileName(sidebarArtifactId)]: { content: sidebarFixture },
          [syncKeyToGistFileName(ghostId)]: { content: "{}\n" },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("aaaabbbbccccddddeeee");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Missing manifest entry for "${ghostId}".`
    );
  });

  it("fails v2 preflight when required store artifact file is absent from bundle", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
      includeStore: true,
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );
    const storeArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "store",
      "store.db"
    );

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-missing-store",
        html_url: "https://gist.github.com/example/gist-missing-store",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: { content: transcriptFixture },
          [syncKeyToGistFileName(sidebarArtifactId)]: { content: sidebarFixture },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("bbbbccccddddeeeeaaaa");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Bundle file missing for "${storeArtifactId}".`
    );
  });

  it("fails v2 preflight when store artifact omits sourceWorkspaceKey metadata", async () => {
    const sourceProjectKey = "source-project";
    const targetProjectKey = "target-project";
    const relativePath = "conversation-123/conversation-123.jsonl";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    const manifest = buildManifest({
      schemaVersion: 2,
      projectKey: sourceProjectKey,
      relativePath,
      content: transcriptFixture,
      includeStore: true,
    });
    const transcriptArtifactId = transcriptArtifactSyncKey(sourceProjectKey, relativePath);
    const sidebarArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "sidebar",
      "sidebar-metadata.json"
    );
    const storeArtifactId = bundleArtifactSyncKey(
      sourceProjectKey,
      "conversation-123",
      "store",
      "store.db"
    );
    const storeBuffer = Buffer.from(storeFixture, "utf-8");
    const storeEncoded = encodeTranscriptArtifact(storeBuffer, true);

    const manifestNoSwk = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
    delete manifestNoSwk.artifacts[storeArtifactId].sourceWorkspaceKey;

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-no-swk",
        html_url: "https://gist.github.com/example/gist-no-swk",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          "transcript-manifest.json": { content: JSON.stringify(manifestNoSwk, null, 2) },
          [syncKeyToGistFileName(transcriptArtifactId)]: { content: transcriptFixture },
          [syncKeyToGistFileName(sidebarArtifactId)]: { content: sidebarFixture },
          [syncKeyToGistFileName(storeArtifactId)]: { content: storeEncoded.content },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("ccccddddeeeeaaaabbbb");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetProjectKey)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items);

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Store "${storeArtifactId}" has no sourceWorkspaceKey; re-export with Cursor Sync or deselect this conversation.`
    );
  });

  it("fails v2 preflight when shared store workspace maps to multiple targets and destination stays unresolved", async () => {
    const targetA = "target-a";
    const targetB = "target-b";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetA), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetB), { recursive: true });

    const { manifest, gistFiles, storeArtifactIdA } = buildManifestAmbiguousSharedStoreWorkspace({
      sharedWorkspaceKey: "dup-ws",
      transcriptContent: transcriptFixture,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-dup-ws",
        html_url: "https://gist.github.com/example/gist-dup-ws",
        description: "Cursor Sync - Agent Transcripts Export",
        files: gistFiles,
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("eeeefaaaabbbbccccdddd");
    showQuickPickMock
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetA)
      )
      .mockImplementationOnce(
        async (items: Array<{ description?: string }>) =>
          items.find((item) => item.description === targetB)
      )
      .mockImplementationOnce(async (items: Array<{ label?: string }>) => items)
      .mockImplementationOnce(async () => ({ label: "noop", description: "" }));

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      `Import preflight failed: Store "${storeArtifactIdA}": map source workspace "dup-ws" to a local chats key.`
    );
  });

  it("reports a missing transcript manifest before writing files", async () => {
    const targetProjectKey = "target-project";
    await fs.mkdir(path.join(tmpRoot, ".cursor", "projects", targetProjectKey), {
      recursive: true,
    });

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-missing-manifest",
        html_url: "https://gist.github.com/example/gist-missing-manifest",
        description: "Cursor Sync - Agent Transcripts Export",
        files: {
          [transcriptGistFileName("source-project", "conversation-123/conversation-123.jsonl")]: {
            content: transcriptFixture,
          },
        },
        created_at: "2026-03-30T12:00:00.000Z",
        updated_at: "2026-03-30T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("fedcbafedcbafedcbafe");

    const { executeImportTranscripts } = await import("../src/transcripts.js");
    await executeImportTranscripts(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Import failed: transcript-manifest.json not found. This Gist may not contain exported transcripts."
    );
  });
});
