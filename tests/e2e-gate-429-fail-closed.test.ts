import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
  window: {
    showQuickPick: vi.fn(async (items: { id: string }[]) => items[0]),
    showInputBox: vi.fn(async () => "any-secret-input"),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());
const unwrapPassMock = vi.hoisted(() => vi.fn());
const unwrapRecoveryMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ."),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  loadStoredDek: vi.fn(async () => undefined),
  storeDek: vi.fn(async () => undefined),
  rememberDekVersion: vi.fn(async () => undefined),
}));

vi.mock("../src/sync-status-bar.js", () => ({
  refreshSyncStatusBar: vi.fn(async () => undefined),
}));

vi.mock("../src/e2e/migration.js", () => ({
  markMigrationPending: vi.fn(async () => undefined),
}));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: vi.fn(),
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "https://api-staging.cursor-sync.com",
}));

vi.mock("../src/e2e/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/gate.js")>();
  return {
    ...actual,
    refreshE2eGateAfterCryptoChange: vi.fn(async () => ({
      phase: "unlocked" as const,
      userId: "user-1",
      keyVersion: 1,
    })),
  };
});

vi.mock("../src/e2e/unlock-crypto.js", () => ({
  unwrapDekWithPassphraseMaterial: unwrapPassMock,
  unwrapDekWithRecoveryMaterial: unwrapRecoveryMock,
  dekMatches: vi.fn(),
}));

const staleMaterialWire = {
  keyVersion: 1,
  kdf: "argon2id",
  kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
  salt: Buffer.alloc(16, 1).toString("base64"),
  passWrap: {
    nonce: Buffer.alloc(12, 2).toString("base64"),
    ct: Buffer.alloc(32).toString("base64"),
  },
  recoveryWrap: {
    nonce: Buffer.alloc(12, 3).toString("base64"),
    ct: Buffer.alloc(32).toString("base64"),
  },
};

const RATE_LIMIT_MSG = "Cursor Sync API rate limit reached, try again in about 3 min";

function makeContext() {
  const globalStateStore = new Map<string, unknown>([
    [
      "cursorSync.e2e.keysCache.v1",
      {
        presence: "set",
        verification: "verified",
        fetchedAtMs: Date.now() - 120_000,
        keyMaterialWire: staleMaterialWire,
      },
    ],
  ]);
  return {
    globalState: {
      get: (key: string) => globalStateStore.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          globalStateStore.delete(key);
        } else {
          globalStateStore.set(key, value);
        }
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as import("vscode").ExtensionContext;
}

describe("gate 429 fail-closed with verified stale cache", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    unwrapPassMock.mockReset();
    unwrapRecoveryMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "RATE_LIMITED" }), {
        status: 429,
        headers: { "Retry-After": "180" },
      })
    );
    unwrapPassMock.mockResolvedValue(Buffer.alloc(32, 1));
    unwrapRecoveryMock.mockReturnValue(Buffer.alloc(32, 2));
  });

  it("rejects unlock with old passphrase, new passphrase, and stale recovery key", async () => {
    const vscode = await import("vscode");
    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const context = makeContext();

    for (const pass of ["OLD-PASS1-stale", "NEW-PASS2-correct"]) {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
        label: "Passphrase",
        id: "pass",
      });
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(pass);
      const ok = await runUnlockFlow(context);
      expect(ok).toBe(false);
    }

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "Use recovery key",
      id: "recovery",
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("stale-recovery-key");
    const okRecovery = await runUnlockFlow(context);
    expect(okRecovery).toBe(false);

    expect(unwrapPassMock).not.toHaveBeenCalled();
    expect(unwrapRecoveryMock).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(RATE_LIMIT_MSG);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith("Sync unlocked.");
  });
});
