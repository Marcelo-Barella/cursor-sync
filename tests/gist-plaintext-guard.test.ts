import { describe, expect, it, vi } from "vitest";

const saveSyncStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadSyncStateMock = vi.hoisted(() =>
  vi.fn(async () => ({
    gistId: "deleted-gist",
    lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
    lastSyncDirection: "pull" as const,
    localChecksums: {},
    remoteChecksums: {},
  }))
);

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/diagnostics.js", () => ({
  loadSyncState: loadSyncStateMock,
  saveSyncState: saveSyncStateMock,
}));
import { GIST_E2E_MARKER_FILE } from "../src/e2e/constants.js";
import {
  assertPlaintextGistWriteAllowed,
  GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE,
  probeSyncGistEncryption,
} from "../src/e2e/gist-plaintext-guard.js";

function mockClient(files: Record<string, { content?: string }>, gistId = "gist-1") {
  return {
    findExistingGist: vi.fn(async () => ({ ok: true, data: { id: gistId } })),
    getGist: vi.fn(async () => ({ ok: true, data: { files } })),
  } as unknown as import("../src/gist.js").GistClient;
}

describe("gist plaintext guard", () => {
  it("blocks plaintext write when sync gist has CSE1 marker", async () => {
    const client = mockClient({
      [GIST_E2E_MARKER_FILE]: {
        content: JSON.stringify({ format: "CSE1", keyVersion: 1 }),
      },
    });
    expect(await probeSyncGistEncryption(client, "gist-1")).toEqual({ state: "encrypted" });
    const guard = await assertPlaintextGistWriteAllowed(client, "gist-1");
    expect(guard.ok).toBe(false);
  });

  it("allows plaintext write when gist has no marker", async () => {
    const client = mockClient({ "manifest.json": { content: "{}" } });
    expect(await probeSyncGistEncryption(client)).toEqual({ state: "plain" });
    const guard = await assertPlaintextGistWriteAllowed(client);
    expect(guard.ok).toBe(true);
  });

  it("treats deleted gist (404) as plain and allows new gist", async () => {
    saveSyncStateMock.mockClear();
    const client = {
      getGist: vi.fn(async () => ({
        ok: false,
        error: { category: "UNKNOWN", message: "Not Found", statusCode: 404 },
      })),
    } as unknown as import("../src/gist.js").GistClient;
    const context = {
      globalState: { get: async () => undefined, update: async () => {} },
    } as unknown as import("vscode").ExtensionContext;
    expect(await probeSyncGistEncryption(client, "deleted-gist", context)).toEqual({
      state: "plain",
    });
    const guard = await assertPlaintextGistWriteAllowed(client, "deleted-gist", context);
    expect(guard.ok).toBe(true);
    expect(saveSyncStateMock).toHaveBeenCalled();
  });

  it("fails closed when gist cannot be read (e.g. GitHub 503)", async () => {
    const client = {
      findExistingGist: vi.fn(async () => ({ ok: true, data: { id: "gist-1" } })),
      getGist: vi.fn(async () => ({
        ok: false,
        error: { category: "NETWORK_ERROR", message: "Server error (503)", statusCode: 503 },
      })),
    } as unknown as import("../src/gist.js").GistClient;
    expect(await probeSyncGistEncryption(client, "gist-1")).toEqual({ state: "unknown" });
    const guard = await assertPlaintextGistWriteAllowed(client, "gist-1");
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.message).toBe(GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE);
    }
  });
});
