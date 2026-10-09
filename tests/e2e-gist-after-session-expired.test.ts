import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn(async () => undefined) },
}));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn(async () => undefined),
  isAppSessionExpired: vi.fn(() => true),
}));

vi.mock("../src/e2e/dek-storage.js", () => ({
  loadStoredDek: vi.fn(async () => undefined),
}));

vi.mock("../src/e2e/keys-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/e2e/keys-client.js")>();
  return {
    ...actual,
    hydrateKeysCacheFromDisk: vi.fn(async () => undefined),
    getCachedKeysGate: vi.fn(() => ({ presence: "unknown", verification: "unknown" })),
    fetchServerKeyMaterial: vi.fn(),
  };
});

describe("gist sync after session expired", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("requireE2eUnlocked blocks gist plaintext when session expired", async () => {
    const { requireE2eUnlocked } = await import("../src/e2e/gate.js");
    const context = {
      globalState: { get: () => undefined, update: async () => undefined },
      secrets: { get: async () => undefined, delete: async () => undefined },
    } as unknown as import("vscode").ExtensionContext;
    const result = await requireE2eUnlocked(context, { gistSync: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Log in to Cursor Sync");
    }
  });
});
