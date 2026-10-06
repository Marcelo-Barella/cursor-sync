import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import { GIST_E2E_MARKER_FILE } from "../src/e2e/constants.js";
import {
  assertPlaintextGistWriteAllowed,
  remoteSyncGistIsEncrypted,
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
    expect(await remoteSyncGistIsEncrypted(client)).toBe(true);
    const guard = await assertPlaintextGistWriteAllowed(client, "gist-1");
    expect(guard.ok).toBe(false);
  });

  it("allows plaintext write when gist has no marker", async () => {
    const client = mockClient({ "manifest.json": { content: "{}" } });
    expect(await remoteSyncGistIsEncrypted(client)).toBe(false);
    const guard = await assertPlaintextGistWriteAllowed(client);
    expect(guard.ok).toBe(true);
  });
});
