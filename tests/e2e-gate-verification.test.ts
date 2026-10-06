import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

import { keysGetResponseToCache, KeysApiError } from "../src/e2e/keys-client.js";

const NONCE_B64 = Buffer.alloc(12, 7).toString("base64");
const CT_B64 = Buffer.alloc(48, 3).toString("base64");
const SALT_B64 = Buffer.alloc(16, 1).toString("base64");

function mockResponse(status: number, body?: object, headers?: Record<string, string>): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
    json: async () => body ?? {},
  } as Response;
}

describe("GET /v1/keys gate verification", () => {
  it("maps 200 to verified keys set", async () => {
    const cache = await keysGetResponseToCache(
      mockResponse(200, {
        keyVersion: 1,
        kdf: "argon2id",
        kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
        salt: SALT_B64,
        passWrap: { nonce: NONCE_B64, ct: CT_B64 },
        recoveryWrap: { nonce: NONCE_B64, ct: CT_B64 },
      })
    );
    expect(cache.presence).toBe("set");
    expect(cache.verification).toBe("verified");
    expect(cache.keyMaterial?.keyVersion).toBe(1);
  });

  it("maps 404 KEYS_NOT_SET to verified without keys", async () => {
    const cache = await keysGetResponseToCache(
      mockResponse(404, { error: "KEYS_NOT_SET" })
    );
    expect(cache.presence).toBe("not_set");
    expect(cache.verification).toBe("verified");
  });

  it("maps 403 EMAIL_NOT_VERIFIED without throwing", async () => {
    const cache = await keysGetResponseToCache(
      mockResponse(403, { error: "EMAIL_NOT_VERIFIED" })
    );
    expect(cache.verification).toBe("email_not_verified");
    expect(cache.presence).toBe("not_set");
  });

  it("maps 401 to unauthorized error", async () => {
    await expect(keysGetResponseToCache(mockResponse(401))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("maps 429 with Retry-After to rate limit error", async () => {
    await expect(
      keysGetResponseToCache(mockResponse(429, { error: "RATE_LIMITED" }, { "Retry-After": "120" }))
    ).rejects.toBeInstanceOf(KeysApiError);
  });
});

describe("resolveE2eGateSnapshot email verification", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not block on missing JWT email_verified when keys API returns 200", async () => {
    vi.doMock("vscode", () => ({}));
    vi.doMock("../src/app-auth.js", () => ({
      getAppSession: async () => "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.",
    }));
    vi.doMock("../src/e2e/dek-storage.js", () => ({
      loadStoredDek: async () => Buffer.alloc(32, 2),
    }));
    vi.doMock("../src/e2e/keys-client.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/e2e/keys-client.js")>();
      return {
        ...actual,
        fetchServerKeyMaterial: async () => ({
          fetchedFromNetwork: true,
          cache: {
            presence: "set" as const,
            verification: "verified" as const,
            keyMaterial: {
              keyVersion: 1,
              kdf: "argon2id" as const,
              kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
              salt: Buffer.alloc(16),
              passWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
              recoveryWrap: { nonce: Buffer.alloc(12), ct: Buffer.alloc(32) },
            },
          },
        }),
        hydrateKeysCacheFromDisk: async () => ({}),
      };
    });

    const { invalidateE2eGateSnapshot, resolveE2eGateSnapshot } = await import("../src/e2e/gate.js");
    invalidateE2eGateSnapshot();
    const context = {
      globalState: { get: async () => undefined, update: async () => {} },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    } as unknown as import("vscode").ExtensionContext;
    const snapshot = await resolveE2eGateSnapshot(context, { bypassCache: true });
    expect(snapshot.phase).toBe("unlocked");
  });
});
