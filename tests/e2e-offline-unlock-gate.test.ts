import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
  window: {
    showQuickPick: vi.fn(async () => ({ label: "Passphrase", id: "pass" })),
    showInputBox: vi.fn(async () => "long-passphrase-ok-12"),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ."),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  loadStoredDek: vi.fn(async () => undefined),
  storeDek: vi.fn(async () => undefined),
  rememberDekVersion: vi.fn(async () => undefined),
  clearStoredDekForUser: vi.fn(async () => undefined),
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
  getAppApiUrl: () => "http://127.0.0.1:9",
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

vi.mock("../src/e2e/unlock-crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/unlock-crypto.js")>();
  return {
    ...actual,
    unwrapDekWithPassphraseMaterial: vi.fn(async () => Buffer.alloc(32, 3)),
  };
});

const keyMaterialWire = {
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

describe("runUnlockFlow with real gate and network failure", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("reaches offline unlock when GET /v1/keys fails with ECONNREFUSED and verified cache exists", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      })
    );

    const globalStateStore = new Map<string, unknown>([
      [
        "cursorSync.e2e.keysCache.v1",
        {
          presence: "set",
          verification: "verified",
          fetchedAtMs: Date.now() - 60_000,
          keyMaterialWire,
        },
      ],
    ]);

    const context = {
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

    const { runUnlockFlow } = await import("../src/e2e/commands.js");
    const vscode = await import("vscode");
    const ok = await runUnlockFlow(context);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Unlocked offline using cached keys"
    );
  });
});
