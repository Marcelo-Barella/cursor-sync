import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

const fetchServerKeyMaterialMock = vi.hoisted(() => vi.fn());
const hydrateMock = vi.hoisted(() => vi.fn());
const getCachedMock = vi.hoisted(() => vi.fn());
const markUnverifiedMock = vi.hoisted(() => vi.fn());

vi.mock("../src/e2e/keys-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/keys-client.js")>();
  return {
    ...actual,
    fetchServerKeyMaterial: fetchServerKeyMaterialMock,
    hydrateKeysCacheFromDisk: hydrateMock,
    getCachedKeysGate: getCachedMock,
    markKeysCacheUnverifiedOffline: markUnverifiedMock,
  };
});

const staleMaterial = {
  keyVersion: 1,
  kdf: "argon2id" as const,
  kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
  salt: Buffer.alloc(16, 1),
  passWrap: { nonce: Buffer.alloc(12, 2), ct: Buffer.alloc(32) },
  recoveryWrap: { nonce: Buffer.alloc(12, 3), ct: Buffer.alloc(32) },
};

const context = {
  globalState: { get: async () => undefined, update: async () => {} },
} as unknown as import("vscode").ExtensionContext;

describe("loadKeyMaterialForCryptoOps offline and rate limits", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchServerKeyMaterialMock.mockReset();
    hydrateMock.mockReset().mockResolvedValue(undefined);
    getCachedMock.mockReset();
    markUnverifiedMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns fail closed on 429 even when stale cache exists", async () => {
    const { KeysApiError } = await import("../src/e2e/keys-client.js");
    const { loadKeyMaterialForCryptoOps } = await import("../src/e2e/key-material-load.js");
    fetchServerKeyMaterialMock.mockRejectedValue(
      new KeysApiError("Cursor Sync API rate limit reached, try again in about 5 min", 429)
    );
    getCachedMock.mockReturnValue({
      presence: "set",
      verification: "verified",
      keyMaterial: staleMaterial,
      fetchedAtMs: Date.now() - 999_999,
    });

    const unlock = await loadKeyMaterialForCryptoOps(context, { allowOfflineFallback: true });
    expect(unlock.ok).toBe(false);
    if (!unlock.ok) {
      expect(unlock.message).toContain("rate limit");
    }
    expect(markUnverifiedMock).not.toHaveBeenCalled();
  });

  it("uses cached keys on network error for unlock and marks unverified offline", async () => {
    const { loadKeyMaterialForCryptoOps } = await import("../src/e2e/key-material-load.js");
    fetchServerKeyMaterialMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      })
    );
    getCachedMock.mockReturnValue({
      presence: "set",
      verification: "verified",
      keyMaterial: staleMaterial,
      fetchedAtMs: Date.now(),
    });

    const result = await loadKeyMaterialForCryptoOps(context, { allowOfflineFallback: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedCacheFallback).toBe(true);
      expect(result.material).toBe(staleMaterial);
    }
    expect(markUnverifiedMock).toHaveBeenCalledWith(context);
  });

  it("refuses offline fallback for change/rotate paths", async () => {
    const { loadKeyMaterialForCryptoOps, OFFLINE_KEY_MATERIAL_MESSAGE } = await import(
      "../src/e2e/key-material-load.js"
    );
    fetchServerKeyMaterialMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      })
    );
    getCachedMock.mockReturnValue({
      presence: "set",
      verification: "verified",
      keyMaterial: staleMaterial,
    });

    const result = await loadKeyMaterialForCryptoOps(context, { allowOfflineFallback: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(OFFLINE_KEY_MATERIAL_MESSAGE);
    }
  });
});

describe("unlock flow messaging (offline)", () => {
  it("exports offline success label", async () => {
    const { OFFLINE_UNLOCK_SUCCESS_LABEL } = await import("../src/e2e/key-material-load.js");
    expect(OFFLINE_UNLOCK_SUCCESS_LABEL).toBe("Unlocked offline using cached keys");
  });
});

describe("keysCacheNeedsRefresh unverified_offline", () => {
  it("always refreshes when verification is unverified_offline", async () => {
    const { keysCacheNeedsRefresh } = await import("../src/e2e/keys-client.js");
    expect(
      keysCacheNeedsRefresh({
        presence: "set",
        verification: "unverified_offline",
        fetchedAtMs: Date.now(),
      })
    ).toBe(true);
  });
});
