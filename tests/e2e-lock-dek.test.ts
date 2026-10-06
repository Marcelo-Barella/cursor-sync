import { describe, expect, it, vi, beforeEach } from "vitest";

const clearStoredDekForUserMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
  },
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  clearStoredDekForUser: clearStoredDekForUserMock,
  loadStoredDek: vi.fn(async () => undefined),
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: vi.fn(async () => undefined),
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => "jwt"),
}));

vi.mock("../src/e2e/keys-client.js", () => ({
  invalidateKeysGateCache: vi.fn(async () => undefined),
  fetchServerKeyMaterial: vi.fn(async () => ({
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
  })),
  hydrateKeysCacheFromDisk: vi.fn(async () => undefined),
  getCachedKeysGate: vi.fn(),
}));

describe("lockLocalDek", () => {
  beforeEach(() => {
    vi.resetModules();
    clearStoredDekForUserMock.mockClear();
  });

  it("clears stored DEKs for lastUserId and cached snapshot versions", async () => {
    const context = {
      globalState: {
        get: (key: string) => {
          if (key === "cursorSync.e2e.lastUserId") return "user-a";
          if (key === "cursorSync.e2e.dekVersions") return [1, 2];
          return undefined;
        },
        update: vi.fn(async () => undefined),
      },
      secrets: {
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as import("vscode").ExtensionContext;

    const gate = await import("../src/e2e/gate.js");
    gate.invalidateE2eGateSnapshot();
    const { lockLocalDek } = gate;

    await lockLocalDek(context);

    expect(clearStoredDekForUserMock).toHaveBeenCalledWith(context, "user-a", 1);
    expect(clearStoredDekForUserMock).toHaveBeenCalledWith(context, "user-a", 2);
  });
});
