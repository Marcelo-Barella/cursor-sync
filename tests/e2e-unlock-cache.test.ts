import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(async () => undefined),
  },
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: vi.fn(async () => undefined),
}));

describe("unlock refreshes gate cache", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls bypassCache refresh after storing DEK", async () => {
    const refreshSpy = vi.fn(async () => ({ phase: "unlocked" as const, userId: "u1", keyVersion: 1 }));
    vi.doMock("../src/e2e/gate.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/e2e/gate.js")>();
      return {
        ...actual,
        resolveE2eGateSnapshot: vi.fn(async () => ({
          phase: "locked" as const,
          userId: "u1",
          keyVersion: 1,
        })),
        refreshE2eGateAfterCryptoChange: refreshSpy,
      };
    });
    vi.doMock("vscode", () => ({
      window: {
        showQuickPick: vi.fn(async () => ({ label: "Passphrase", id: "pass" })),
        showInputBox: vi.fn(async () => "long-passphrase-ok"),
        showInformationMessage: vi.fn(async () => undefined),
        showErrorMessage: vi.fn(),
      },
      commands: { executeCommand: vi.fn(async () => undefined) },
    }));
    const keyMaterial = {
      keyVersion: 1,
      kdf: "argon2id" as const,
      kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
      salt: Buffer.alloc(16, 1),
      passWrap: {
        nonce: Buffer.alloc(12, 2),
        ct: Buffer.concat([Buffer.alloc(16), Buffer.alloc(16)]),
      },
      recoveryWrap: {
        nonce: Buffer.alloc(12, 3),
        ct: Buffer.concat([Buffer.alloc(16), Buffer.alloc(16)]),
      },
    };
    vi.doMock("../src/e2e/key-material-load.js", () => ({
      loadKeyMaterialForCryptoOps: vi.fn(async () => ({
        ok: true,
        material: keyMaterial,
        usedCacheFallback: false,
      })),
    }));
    vi.doMock("../src/e2e/keys-client.js", () => ({
      hydrateKeysCacheFromDisk: vi.fn(async () => undefined),
      getCachedKeysGate: vi.fn(() => ({
        presence: "set",
        verification: "verified",
        keyMaterial,
      })),
      fetchServerKeyMaterial: vi.fn(),
      invalidateKeysGateCache: vi.fn(async () => undefined),
    }));
    vi.doMock("../src/e2e/key-material.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/e2e/key-material.js")>();
      return {
        ...actual,
        unwrapDekWithPassphrase: vi.fn(async () => Buffer.alloc(32, 9)),
      };
    });
    vi.doMock("../src/e2e/dek-storage.js", () => ({
      storeDek: vi.fn(async () => undefined),
      rememberDekVersion: vi.fn(async () => undefined),
    }));
    vi.doMock("../src/e2e/migration.js", () => ({
      markMigrationPending: vi.fn(async () => undefined),
    }));
    vi.doMock("../src/sidebar/index.js", () => ({
      refreshSidebar: vi.fn(),
    }));

    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const context = {
      globalState: { get: async () => undefined, update: async () => {} },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    } as unknown as import("vscode").ExtensionContext;

    const ok = await runUnlockFlow(context);
    expect(ok).toBe(true);
    expect(refreshSpy).toHaveBeenCalled();
  });
});
