import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));
vi.mock("../src/app-auth.js", () => ({
  getAppSession: async () => undefined,
}));
vi.mock("../src/diagnostics.js", () => ({
  loadSyncState: async () => undefined,
}));
vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "https://api.test.local",
}));
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  envelopeFromBase64Wire,
  envelopeToBase64Wire,
  E2eCryptoError,
  packCse1Envelope,
  unpackCse1Envelope,
} from "../src/e2e/envelope.js";
import {
  computeDekVerifierHex,
  deriveGistFileNameHex,
  encryptObjectPayload,
  decryptObjectPayload,
  generateDek,
  generateSalt,
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
  wrapDekForPassphrase,
  wrapDekForRecovery,
} from "../src/e2e/key-material.js";
import { generateRecoveryKeyBytes } from "../src/e2e/recovery-key.js";
import {
  decryptManifestPayload,
  encryptManifestPayload,
  ConfigsManifestConflictError,
} from "../src/e2e/configs-sync.js";
import type { E2eConfigsManifestPayload } from "../src/e2e/manifest-payload.js";
import {
  decryptChatGistPayload,
  encryptChatGistPayload,
} from "../src/chat-gist-crypto.js";
import {
  loadMigrationState,
  markMigrationCompleted,
  markMigrationPending,
  saveMigrationState,
} from "../src/e2e/migration.js";
import { encryptGistFileContent, decryptGistFileContent } from "../src/e2e/gist-e2e.js";
import { wrapGistFilesForUpload } from "../src/e2e/gist-bundle.js";
import { GIST_E2E_MARKER_FILE } from "../src/e2e/constants.js";

const USER_ID = "user_test_01";
const KEY_VERSION = 1;

function mockContext(
  globalState: Record<string, unknown> = {}
): import("vscode").ExtensionContext {
  const store = new Map<string, unknown>(Object.entries(globalState));
  return {
    globalState: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
    globalStorageUri: { fsPath: "/tmp/e2e-crypto-test" },
  } as unknown as import("vscode").ExtensionContext;
}

describe("e2e crypto matrix", () => {
  it("wraps and unwraps DEK with passphrase", async () => {
    const dek = generateDek();
    const salt = generateSalt();
    const passphrase = "correct horse battery staple";
    const wrapped = await wrapDekForPassphrase(dek, passphrase, USER_ID, KEY_VERSION, salt);
    const unwrapped = await unwrapDekWithPassphrase(
      wrapped.wrap,
      passphrase,
      USER_ID,
      KEY_VERSION,
      wrapped.salt,
      wrapped.kdfParams
    );
    expect(unwrapped.equals(dek)).toBe(true);
    expect(computeDekVerifierHex(unwrapped)).toBe(computeDekVerifierHex(dek));
  });

  it("rejects wrong passphrase on unwrap", async () => {
    const dek = generateDek();
    const salt = generateSalt();
    const wrapped = await wrapDekForPassphrase(dek, "right-pass", USER_ID, KEY_VERSION, salt);
    await expect(
      unwrapDekWithPassphrase(
        wrapped.wrap,
        "wrong-pass",
        USER_ID,
        KEY_VERSION,
        wrapped.salt,
        wrapped.kdfParams
      )
    ).rejects.toMatchObject({ code: "WRONG_PASSPHRASE" });
  });

  it("unwraps DEK with recovery key", () => {
    const dek = generateDek();
    const recoveryBytes = generateRecoveryKeyBytes();
    const wrap = wrapDekForRecovery(dek, recoveryBytes, USER_ID, KEY_VERSION);
    const unwrapped = unwrapDekWithRecoveryKey(wrap, recoveryBytes, USER_ID, KEY_VERSION);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("detects tampered CSE1 envelope on decrypt", () => {
    const dek = generateDek();
    const plain = Buffer.from("manifest-body", "utf8");
    const syncKey = "configs/manifest";
    const envelope = encryptObjectPayload(dek, plain, USER_ID, KEY_VERSION, syncKey);
    const { nonce, ciphertextWithTag } = unpackCse1Envelope(envelope);
    const tamperedTag = Buffer.from(ciphertextWithTag);
    tamperedTag[tamperedTag.length - 1] ^= 0xff;
    const tampered = packCse1Envelope(KEY_VERSION, nonce, tamperedTag);
    expect(() =>
      decryptObjectPayload(dek, tampered, USER_ID, KEY_VERSION, syncKey)
    ).toThrow(E2eCryptoError);
  });

  it("round-trips object payload with stable gist file name derivation", () => {
    const dek = generateDek();
    const a = deriveGistFileNameHex(dek, "manifest.json");
    const b = deriveGistFileNameHex(dek, "manifest.json");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const enc = encryptGistFileContent(dek, '{"x":1}', USER_ID, KEY_VERSION, "manifest.json");
    const dec = decryptGistFileContent(dek, enc.content, USER_ID, KEY_VERSION, "manifest.json");
    expect(dec).toBe('{"x":1}');
  });

  it("round-trips encrypted manifest payload", () => {
    const dek = generateDek();
    const payload: E2eConfigsManifestPayload = {
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: new Date().toISOString(),
        sourceMachineId: "m",
        sourceOS: "linux",
        files: {
          "cursor-user/settings.json": { checksum: "abc", sizeBytes: 3 },
        },
      },
      files: {
        "cursor-user/settings.json": { checksum: "abc", sizeBytes: 3 },
      },
    };
    const wire = encryptManifestPayload(dek, USER_ID, KEY_VERSION, payload);
    const round = decryptManifestPayload(dek, USER_ID, KEY_VERSION, wire);
    expect(round.manifest.files["cursor-user/settings.json"]?.checksum).toBe("abc");
  });

  it("wraps gist uploads with marker file", () => {
    const dek = generateDek();
    const files = wrapGistFilesForUpload(dek, USER_ID, KEY_VERSION, {
      "manifest.json": { content: "{}" },
    });
    expect(files[GIST_E2E_MARKER_FILE]?.content).toContain("CSE1");
    expect(files["manifest.json"]).toBeUndefined();
    const encName = deriveGistFileNameHex(dek, "manifest.json");
    expect(files[encName]?.content).toBeTruthy();
  });

  it("retries manifest PUT on 409 MANIFEST_VERSION_MISMATCH", async () => {
    vi.resetModules();
    vi.doMock("../src/app-auth.js", () => ({
      getAppSession: async () => "session-jwt",
    }));

    const context = mockContext();
    const dek = generateDek();
    const manifestCiphertext = encryptManifestPayload(dek, USER_ID, KEY_VERSION, {
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        syncProfileName: "default",
        createdAt: new Date().toISOString(),
        sourceMachineId: "m",
        sourceOS: "linux",
        files: {},
      },
      files: {},
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          payload: null,
          manifestCiphertext: null,
          manifestVersion: 2,
          updated_at: new Date().toISOString(),
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: "MANIFEST_VERSION_MISMATCH" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          payload: null,
          manifestCiphertext: null,
          manifestVersion: 3,
          updated_at: new Date().toISOString(),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          payload: null,
          manifestCiphertext,
          manifestVersion: 3,
          updated_at: new Date().toISOString(),
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const { putConfigsManifestWithRetry } = await import("../src/e2e/configs-sync.js");
    const result = await putConfigsManifestWithRetry(context, (expected) => ({
      manifestCiphertext,
      expectedManifestVersion: expected,
      clearLegacyPayload: true,
    }));

    expect(result.manifestVersion).toBe(3);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("decrypts legacy chat gist password envelope", async () => {
    const password = "legacy-chat-password";
    const plaintext = JSON.stringify({ hello: "world" });
    const envelope = await encryptChatGistPayload(plaintext, password, "chat-bundle");
    const decrypted = await decryptChatGistPayload(envelope, password);
    expect(decrypted).toBe(plaintext);
  });

  it("migration pending to completed is idempotent", async () => {
    const context = mockContext();
    await markMigrationPending(context);
    await markMigrationCompleted(context);
    expect((await loadMigrationState(context))?.phase).toBe("completed");
    await markMigrationCompleted(context);
    expect((await loadMigrationState(context))?.phase).toBe("completed");
  });

  it("AES-GCM wire envelope round-trip", () => {
    const dek = generateDek();
    const aad = "cursor-sync/obj/v1|u|1|key";
    const plain = Buffer.from("payload", "utf8");
    const env = encryptAes256Gcm(dek, plain, aad, KEY_VERSION);
    const b64 = envelopeToBase64Wire(env);
    const back = decryptAes256Gcm(dek, envelopeFromBase64Wire(b64), aad);
    expect(back.toString("utf8")).toBe("payload");
  });
});

describe("configs conflict error", () => {
  it("exposes MANIFEST_VERSION_MISMATCH name", () => {
    const err = new ConfigsManifestConflictError();
    expect(err.message).toBe("MANIFEST_VERSION_MISMATCH");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
