import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchConfigsApiMock = vi.hoisted(() => vi.fn());
const getAppSessionMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: getAppSessionMock,
}));

vi.mock("../src/e2e/configs-sync.js", () => ({
  fetchConfigsApi: fetchConfigsApiMock,
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn() }),
  loadSyncState: vi.fn(async () => ({ gistId: undefined })),
}));

vi.mock("../src/e2e/migration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/migration.js")>();
  return {
    ...actual,
    loadMigrationState: vi.fn(async () => ({
      phase: "in_progress" as const,
      completedPlaintextR2Keys: [],
      completedPlaintextGistFiles: [],
    })),
    saveMigrationState: vi.fn(async () => undefined),
  };
});

function makeContext(): import("vscode").ExtensionContext {
  return {
    globalState: { get: async () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  } as unknown as import("vscode").ExtensionContext;
}

describe("legacy plaintext cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
    getAppSessionMock.mockResolvedValue("jwt");
    fetchConfigsApiMock.mockResolvedValue({
      payload: null,
      manifestCiphertext: "x",
      manifestVersion: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("deletes all 5 legacy objects from plaintext-objects listing", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    let listCalls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/plaintext-objects") && (!init?.method || init.method === "GET")) {
        listCalls += 1;
        if (listCalls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ keys }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [] }),
        } as Response;
      }
      if (url.includes("/plaintext-objects/delete")) {
        const body = JSON.parse(String(init?.body)) as { keys: string[] };
        const payload = {
          results: body.keys.map((key) => ({ key, status: "deleted" })),
        };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { runLegacyPlaintextCleanup } = await import("../src/e2e/legacy-cleanup.js");
    const result = await runLegacyPlaintextCleanup(makeContext());
    expect(result.deleted).toHaveLength(5);
    expect(result.remainingKeys).toEqual([]);
    expect(result.partial).toBe(false);
  });

  it("includes stray keys from plaintext-objects even when configs payload is cleared", async () => {
    fetchConfigsApiMock.mockResolvedValue({
      payload: null,
      manifestCiphertext: "x",
      manifestVersion: 2,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    let listCalls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/plaintext-objects") && (!init?.method || init.method === "GET")) {
        listCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: listCalls === 1 ? ["stray-key"] : [] }),
        } as Response;
      }
      if (url.includes("/plaintext-objects/delete")) {
        const payload = { results: [{ key: "stray-key", status: "deleted" }] };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { runLegacyPlaintextCleanup } = await import("../src/e2e/legacy-cleanup.js");
    const result = await runLegacyPlaintextCleanup(makeContext());
    expect(result.remainingKeys).toEqual([]);
    expect(result.deleted).toContain("stray-key");
  });

  it("keeps migration pending on 502 partial delete failures", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/plaintext-objects") && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: ["k2"] }),
        } as Response;
      }
      if (url.includes("/plaintext-objects/delete")) {
        const payload = {
          results: [
            { key: "k1", status: "deleted" },
            { key: "k2", status: "failed" },
          ],
        };
        return {
          ok: false,
          status: 502,
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { runLegacyPlaintextCleanup } = await import("../src/e2e/legacy-cleanup.js");
    fetchConfigsApiMock.mockResolvedValue({
      payload: null,
      manifestCiphertext: "x",
      manifestVersion: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const { tryCompleteMigration, loadMigrationState } = await import("../src/e2e/migration.js");
    const result = await runLegacyPlaintextCleanup(makeContext());
    expect(result.partial).toBe(true);
    expect(result.failed).toContain("k2");
    await tryCompleteMigration(makeContext(), "app");
    const state = await loadMigrationState(makeContext());
    expect(state?.phase).not.toBe("completed");
  });

});
