import { describe, expect, it, vi, beforeEach } from "vitest";

const showErrorMessage = vi.hoisted(() => vi.fn());
const showInformationMessage = vi.hoisted(() => vi.fn());
const loadKeyMaterialMock = vi.hoisted(() => vi.fn());
const unwrapPassMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(async () => ({ label: "Passphrase", id: "pass" })),
    showInputBox: vi.fn(async () => "user-passphrase-here"),
    showInformationMessage,
    showErrorMessage,
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

vi.mock("../src/e2e/gate.js", () => ({
  resolveE2eGateSnapshot: vi.fn(async () => ({
    phase: "locked" as const,
    userId: "u1",
    keyVersion: 1,
  })),
  refreshE2eGateAfterCryptoChange: vi.fn(async () => ({ phase: "unlocked" as const })),
}));

vi.mock("../src/e2e/key-material-load.js", () => ({
  loadKeyMaterialForCryptoOps: loadKeyMaterialMock,
  OFFLINE_UNLOCK_SUCCESS_LABEL: "Unlocked offline using cached keys",
}));

vi.mock("../src/e2e/unlock-crypto.js", () => ({
  unwrapDekWithPassphraseMaterial: unwrapPassMock,
  unwrapDekWithRecoveryMaterial: vi.fn(),
  dekMatches: vi.fn(),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  storeDek: vi.fn(async () => undefined),
  rememberDekVersion: vi.fn(async () => undefined),
}));

vi.mock("../src/e2e/migration.js", () => ({
  markMigrationPending: vi.fn(async () => undefined),
}));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: vi.fn(),
}));

const keyMaterial = {
  keyVersion: 1,
  kdf: "argon2id" as const,
  kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
  salt: Buffer.alloc(16),
  passWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
  recoveryWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
};

describe("runUnlockFlow rate limit and offline", () => {
  beforeEach(() => {
    vi.resetModules();
    showErrorMessage.mockClear();
    showInformationMessage.mockClear();
    loadKeyMaterialMock.mockReset();
    unwrapPassMock.mockReset();
  });

  it("stays locked on 429 (no cache fallback)", async () => {
    loadKeyMaterialMock.mockResolvedValue({
      ok: false,
      message: "Cursor Sync API rate limit reached, try again in about 2 min",
    });

    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const context = {} as import("vscode").ExtensionContext;
    const ok = await runUnlockFlow(context);
    expect(ok).toBe(false);
    expect(showErrorMessage).toHaveBeenCalledWith(
      "Cursor Sync API rate limit reached, try again in about 2 min"
    );
    expect(unwrapPassMock).not.toHaveBeenCalled();
  });

  it("shows offline wrong-passphrase message when cache fallback was used", async () => {
    loadKeyMaterialMock.mockResolvedValue({
      ok: true,
      material: keyMaterial,
      usedCacheFallback: true,
    });
    unwrapPassMock.mockRejectedValue(new Error("bad wrap"));

    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const ok = await runUnlockFlow({} as import("vscode").ExtensionContext);
    expect(ok).toBe(false);
    expect(showErrorMessage).toHaveBeenCalledWith(
      "Wrong passphrase (offline; if you changed it recently, reconnect and try again)."
    );
  });

  it("shows offline success label when unlock succeeds with cached keys", async () => {
    loadKeyMaterialMock.mockResolvedValue({
      ok: true,
      material: keyMaterial,
      usedCacheFallback: true,
    });
    unwrapPassMock.mockResolvedValue(Buffer.alloc(32, 7));

    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const ok = await runUnlockFlow({} as import("vscode").ExtensionContext);
    expect(ok).toBe(true);
    expect(showInformationMessage).toHaveBeenCalledWith("Unlocked offline using cached keys");
  });
});

describe("change passphrase and rotate on network error", () => {
  beforeEach(() => {
    vi.resetModules();
    showErrorMessage.mockClear();
    loadKeyMaterialMock.mockReset();
  });

  it("executeE2eChangePassphrase fails when key load is offline-blocked", async () => {
    vi.doMock("../src/e2e/gate.js", () => ({
      requireE2eUnlocked: vi.fn(async () => ({
        ok: true,
        kind: "dek",
        userId: "u1",
        keyVersion: 1,
        dek: Buffer.alloc(32),
      })),
      isE2eDekUnlocked: (r: { ok: boolean; kind?: string }) => r.ok && r.kind === "dek",
    }));
    loadKeyMaterialMock.mockResolvedValue({
      ok: false,
      message: "Could not reach the Cursor Sync API. Connect to the internet and try again.",
    });

    const { executeE2eChangePassphrase } = await import("../src/e2e/commands.js");
    await executeE2eChangePassphrase({} as import("vscode").ExtensionContext);
    expect(showErrorMessage).toHaveBeenCalledWith(
      "Could not reach the Cursor Sync API. Connect to the internet and try again."
    );
  });

  it("executeE2eRotateRecoveryKey fails when key load is offline-blocked", async () => {
    vi.doMock("../src/e2e/gate.js", () => ({
      requireE2eUnlocked: vi.fn(async () => ({
        ok: true,
        kind: "dek",
        userId: "u1",
        keyVersion: 1,
        dek: Buffer.alloc(32),
      })),
      isE2eDekUnlocked: (r: { ok: boolean; kind?: string }) => r.ok && r.kind === "dek",
    }));
    loadKeyMaterialMock.mockResolvedValue({
      ok: false,
      message: "Could not reach the Cursor Sync API. Connect to the internet and try again.",
    });

    const { executeE2eRotateRecoveryKey } = await import("../src/e2e/commands.js");
    await executeE2eRotateRecoveryKey({} as import("vscode").ExtensionContext);
    expect(showErrorMessage).toHaveBeenCalledWith(
      "Could not reach the Cursor Sync API. Connect to the internet and try again."
    );
  });
});
