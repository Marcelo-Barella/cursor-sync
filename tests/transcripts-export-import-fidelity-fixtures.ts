import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import {
  bundleArtifactSyncKey,
  encodeTranscriptArtifact,
  syncKeyToGistFileName,
} from "../src/transcript-bundle.js";

export const createGistMock = vi.fn();
export const getGistMock = vi.fn();
export const requireTokenMock = vi.fn();
export const getTokenMock = vi.fn();
export const withRetryMock = vi.fn(async <T>(fn: () => Promise<T>) => fn());
export const appendLineMock = vi.fn();
export const showInformationMessageMock = vi.fn();
export const showWarningMessageMock = vi.fn();
export const showErrorMessageMock = vi.fn();
export const showInputBoxMock = vi.fn();
export const showQuickPickMock = vi.fn();
export const clipboardWriteTextMock = vi.fn();
export const mockedHomeDir = { current: "" };

export const configurationValues: Record<string, unknown> = {
  "transcripts.enabled": true,
  "transcripts.maxFileSizeKB": 2048,
};

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockedHomeDir.current,
  };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
      update: vi.fn(),
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: appendLineMock,
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: showInformationMessageMock,
    showWarningMessage: showWarningMessageMock,
    showErrorMessage: showErrorMessageMock,
    showInputBox: showInputBoxMock,
    showQuickPick: showQuickPickMock,
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
  env: {
    clipboard: {
      writeText: clipboardWriteTextMock,
    },
  },
  ProgressLocation: {
    Notification: 15,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));

vi.mock("../src/gist.js", () => ({
  GistClient: class {
    createGist = createGistMock;
    getGist = getGistMock;
  },
}));

vi.mock("../src/auth.js", () => ({
  requireToken: requireTokenMock,
  getToken: getTokenMock,
}));

vi.mock("../src/retry.js", () => ({
  withRetry: withRetryMock,
}));

vi.mock("../src/e2e/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/gate.js")>();
  return {
    ...actual,
    requireE2eUnlocked: vi.fn(async () => ({
      ok: true as const,
      kind: "dek" as const,
      dek: Buffer.alloc(32, 4),
      userId: "transcript-test-user",
      keyVersion: 1,
    })),
  };
});

vi.mock("../src/e2e/gist-bundle.js", () => ({
  wrapGistFilesForUpload: vi.fn(
    (_dek: Buffer, _userId: string, _keyVersion: number, logicalFiles: Record<string, { content: string }>) => ({
      ...logicalFiles,
      "cursor-sync-e2e.json": {
        content: JSON.stringify({ format: "CSE1", keyVersion: 1 }),
      },
    })
  ),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testsDir, "fixtures", "transcripts-bundle-v2");
export const transcriptFixture = readFileSync(path.join(fixtureDir, "conversation.jsonl"), "utf-8");
export const sidebarFixture = readFileSync(path.join(fixtureDir, "sidebar-snapshot.json"), "utf-8");
export const storeFixture = readFileSync(path.join(fixtureDir, "store-snapshot.json"), "utf-8");

function transcriptSyncKey(projectKey: string, relativePath: string): string {
  return `transcripts/${projectKey}/${relativePath}`;
}

export function transcriptGistFileName(projectKey: string, relativePath: string): string {
  return transcriptSyncKey(projectKey, relativePath).replace(/\//g, "--");
}

export function transcriptArtifactSyncKey(projectKey: string, relativePath: string): string {
  const conversationId = relativePath.split("/")[0] ?? relativePath;
  const scopedRelativePath = relativePath.includes("/")
    ? relativePath.split("/").slice(1).join("/")
    : relativePath;
  return bundleArtifactSyncKey(projectKey, conversationId, "transcript", scopedRelativePath);
}

export function buildManifest(options: {
  schemaVersion: 1 | 2;
  projectKey: string;
  relativePath: string;
  content: string;
  includeStore?: boolean;
  storeSourceWorkspaceKey?: string;
}) {
  const { schemaVersion, projectKey, relativePath, content, includeStore, storeSourceWorkspaceKey } =
    options;
  const syncKey = transcriptSyncKey(projectKey, relativePath);
  const checksum = crypto.createHash("sha256").update(content).digest("hex");
  const base = {
    schemaVersion,
    type: "agent-transcripts" as const,
    createdAt: "2026-03-30T12:00:00.000Z",
    sourceMachineId: "source-machine",
    sourceOS: "linux",
    sourceProjects: {
      [projectKey]: {
        folderName: projectKey,
        fileCount: 1,
      },
    },
    files: {
      [syncKey]: {
        projectKey,
        checksum,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
      },
    },
  };

  if (schemaVersion === 1) {
    return base;
  }

  const transcriptArtifactId = transcriptArtifactSyncKey(projectKey, relativePath);
  const conversationId = relativePath.split("/")[0] ?? relativePath;
  const transcriptSize = Buffer.byteLength(content, "utf-8");
  const sidebarArtifactId = bundleArtifactSyncKey(
    projectKey,
    conversationId,
    "sidebar",
    "sidebar-metadata.json"
  );
  const sidebarChecksum = crypto.createHash("sha256").update(sidebarFixture).digest("hex");
  const storeBuffer = Buffer.from(storeFixture, "utf-8");
  const storeEncoded = encodeTranscriptArtifact(storeBuffer, true);
  const storeChecksum = crypto.createHash("sha256").update(storeBuffer).digest("hex");
  const storeArtifactId = bundleArtifactSyncKey(projectKey, conversationId, "store", "store.db");
  const artifactCount = includeStore ? 3 : 2;

  const artifacts: Record<
    string,
    {
      projectKey: string;
      conversationId: string;
      kind: "transcript" | "sidebar" | "store";
      checksum: string;
      sizeBytes: number;
      contentType: string;
      sourceRelativePath?: string;
      encoding?: "base64";
      sourceWorkspaceKey?: string;
    }
  > = {
    [transcriptArtifactId]: {
      projectKey,
      conversationId,
      kind: "transcript",
      checksum,
      sizeBytes: transcriptSize,
      contentType: "application/x-jsonlines",
      sourceRelativePath: relativePath,
    },
    [sidebarArtifactId]: {
      projectKey,
      conversationId,
      kind: "sidebar",
      checksum: sidebarChecksum,
      sizeBytes: Buffer.byteLength(sidebarFixture, "utf-8"),
      contentType: "application/json",
    },
  };

  if (includeStore) {
    artifacts[storeArtifactId] = {
      projectKey,
      conversationId,
      kind: "store",
      checksum: storeChecksum,
      sizeBytes: storeBuffer.length,
      contentType: "application/octet-stream",
      encoding: storeEncoded.encoding,
      sourceWorkspaceKey: storeSourceWorkspaceKey ?? "source-workspace-hash",
    };
  }

  return {
    schemaVersion: 2 as const,
    type: "agent-transcripts" as const,
    createdAt: base.createdAt,
    sourceMachineId: base.sourceMachineId,
    sourceOS: base.sourceOS,
    sourceProjects: {
      [projectKey]: {
        folderName: projectKey,
        fileCount: 1,
        conversationCount: 1,
        artifactCount,
      },
    },
    artifacts,
    conversations: {
      [`${projectKey}:${conversationId}`]: {
        projectKey,
        conversationId,
        title: "Conversation 123",
        subtitle: "3 messages · user, assistant, tool",
        previewText: "tool-result",
        lastUpdatedAt: base.createdAt,
        transcriptArtifacts: [transcriptArtifactId],
        sidebarArtifact: sidebarArtifactId,
        storeArtifact: includeStore ? storeArtifactId : undefined,
        warnings: [],
      },
    },
    warnings: [],
    fidelity: {
      transcriptBytes: "exact",
      storeSnapshots: ["stores/source-project/conversation-123/store.db.json"],
      sidebarSnapshots: ["sidebar/source-project/composer-headers.json"],
    },
    limitations: [
      "Current import ignores store.db snapshots.",
      "Current import ignores sidebar metadata snapshots.",
    ],
  };
}

export function buildManifestAmbiguousSharedStoreWorkspace(options: {
  sharedWorkspaceKey: string;
  transcriptContent: string;
}) {
  const { sharedWorkspaceKey, transcriptContent } = options;
  const pkA = "source-a";
  const pkB = "source-b";
  const convA = "conv-a";
  const convB = "conv-b";
  const relA = `${convA}/${convA}.jsonl`;
  const relB = `${convB}/${convB}.jsonl`;
  const tA = transcriptArtifactSyncKey(pkA, relA);
  const tB = transcriptArtifactSyncKey(pkB, relB);
  const sA = bundleArtifactSyncKey(pkA, convA, "sidebar", "sidebar-metadata.json");
  const sB = bundleArtifactSyncKey(pkB, convB, "sidebar", "sidebar-metadata.json");
  const stA = bundleArtifactSyncKey(pkA, convA, "store", "store.db");
  const stB = bundleArtifactSyncKey(pkB, convB, "store", "store.db");
  const chkT = crypto.createHash("sha256").update(transcriptContent).digest("hex");
  const sbChk = crypto.createHash("sha256").update(sidebarFixture).digest("hex");
  const storeBuf = Buffer.from(storeFixture, "utf-8");
  const storeEnc = encodeTranscriptArtifact(storeBuf, true);
  const chkSt = crypto.createHash("sha256").update(storeBuf).digest("hex");

  const manifest = {
    schemaVersion: 2 as const,
    type: "agent-transcripts" as const,
    createdAt: "2026-03-30T12:00:00.000Z",
    sourceMachineId: "source-machine",
    sourceOS: "linux",
    sourceProjects: {
      [pkA]: {
        folderName: pkA,
        fileCount: 1,
        conversationCount: 1,
        artifactCount: 3,
      },
      [pkB]: {
        folderName: pkB,
        fileCount: 1,
        conversationCount: 1,
        artifactCount: 3,
      },
    },
    artifacts: {
      [tA]: {
        projectKey: pkA,
        conversationId: convA,
        kind: "transcript" as const,
        checksum: chkT,
        sizeBytes: Buffer.byteLength(transcriptContent, "utf-8"),
        contentType: "application/x-jsonlines",
        sourceRelativePath: relA,
      },
      [tB]: {
        projectKey: pkB,
        conversationId: convB,
        kind: "transcript" as const,
        checksum: chkT,
        sizeBytes: Buffer.byteLength(transcriptContent, "utf-8"),
        contentType: "application/x-jsonlines",
        sourceRelativePath: relB,
      },
      [sA]: {
        projectKey: pkA,
        conversationId: convA,
        kind: "sidebar" as const,
        checksum: sbChk,
        sizeBytes: Buffer.byteLength(sidebarFixture, "utf-8"),
        contentType: "application/json",
      },
      [sB]: {
        projectKey: pkB,
        conversationId: convB,
        kind: "sidebar" as const,
        checksum: sbChk,
        sizeBytes: Buffer.byteLength(sidebarFixture, "utf-8"),
        contentType: "application/json",
      },
      [stA]: {
        projectKey: pkA,
        conversationId: convA,
        kind: "store" as const,
        checksum: chkSt,
        sizeBytes: storeBuf.length,
        contentType: "application/octet-stream",
        encoding: storeEnc.encoding,
        sourceWorkspaceKey: sharedWorkspaceKey,
      },
      [stB]: {
        projectKey: pkB,
        conversationId: convB,
        kind: "store" as const,
        checksum: chkSt,
        sizeBytes: storeBuf.length,
        contentType: "application/octet-stream",
        encoding: storeEnc.encoding,
        sourceWorkspaceKey: sharedWorkspaceKey,
      },
    },
    conversations: {
      [`${pkA}:${convA}`]: {
        projectKey: pkA,
        conversationId: convA,
        title: "A",
        subtitle: "s",
        previewText: "p",
        lastUpdatedAt: "2026-03-30T12:00:00.000Z",
        transcriptArtifacts: [tA],
        sidebarArtifact: sA,
        storeArtifact: stA,
        warnings: [],
      },
      [`${pkB}:${convB}`]: {
        projectKey: pkB,
        conversationId: convB,
        title: "B",
        subtitle: "s",
        previewText: "p",
        lastUpdatedAt: "2026-03-30T12:00:00.000Z",
        transcriptArtifacts: [tB],
        sidebarArtifact: sB,
        storeArtifact: stB,
        warnings: [],
      },
    },
    warnings: [] as string[],
    fidelity: {
      transcriptBytes: "exact",
      storeSnapshots: [],
      sidebarSnapshots: [],
    },
    limitations: [],
  };

  const gistFiles = {
    "transcript-manifest.json": { content: JSON.stringify(manifest, null, 2) },
    [syncKeyToGistFileName(tA)]: { content: transcriptContent },
    [syncKeyToGistFileName(tB)]: { content: transcriptContent },
    [syncKeyToGistFileName(sA)]: { content: sidebarFixture },
    [syncKeyToGistFileName(sB)]: { content: sidebarFixture },
    [syncKeyToGistFileName(stA)]: { content: storeEnc.content },
    [syncKeyToGistFileName(stB)]: { content: storeEnc.content },
  };

  return { manifest, gistFiles, storeArtifactIdA: stA };
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
