import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

const fetchServerKeyMaterialMock = vi.hoisted(() => vi.fn());
const hydrateMock = vi.hoisted(() => vi.fn());
const getCachedMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ."),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  loadStoredDek: vi.fn(async () => Buffer.alloc(32, 2)),
  clearStoredDekForUser: vi.fn(async () => undefined),
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: vi.fn(async () => undefined),
}));

vi.mock("../src/e2e/keys-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/keys-client.js")>();
  return {
    ...actual,
    hydrateKeysCacheFromDisk: hydrateMock,
    getCachedKeysGate: getCachedMock,
    fetchServerKeyMaterial: fetchServerKeyMaterialMock,
    invalidateKeysGateCache: vi.fn(async () => undefined),
  };
});

describe("refreshE2eGateOnActivation", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchServerKeyMaterialMock.mockReset();
    hydrateMock.mockReset().mockResolvedValue(undefined);
    getCachedMock.mockReset();
  });

  it("refetches keys when cache says email_not_verified and server says verified", async () => {
    getCachedMock.mockReturnValue({
      presence: "not_set",
      verification: "email_not_verified",
      fetchedAtMs: Date.now() - 60_000,
    });
    fetchServerKeyMaterialMock.mockResolvedValue({
      presence: "set",
      verification: "verified",
      keyMaterial: {
        keyVersion: 1,
        kdf: "argon2id",
        kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
        salt: Buffer.alloc(16),
        passWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
        recoveryWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
      },
      fetchedAtMs: Date.now(),
    });

    const { refreshE2eGateOnActivation, invalidateE2eGateSnapshot } = await import(
      "../src/e2e/gate.js"
    );
    invalidateE2eGateSnapshot();
    const context = {
      globalState: { get: async () => undefined, update: async () => {} },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    } as unknown as import("vscode").ExtensionContext;

    const snapshot = await refreshE2eGateOnActivation(context);
    expect(fetchServerKeyMaterialMock).toHaveBeenCalledWith(context, { force: true });
    expect(snapshot.phase).toBe("unlocked");
  });
});
