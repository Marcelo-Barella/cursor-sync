import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const showErrorMessageMock = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: showErrorMessageMock,
  },
}));

const getAppSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-auth.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
  getAppSession: getAppSessionMock,
}));

const awsFetchMock = vi.hoisted(() => vi.fn());

vi.mock("aws4fetch", () => ({
  AwsClient: vi.fn().mockImplementation(() => ({
    fetch: awsFetchMock,
  })),
}));

function makeContext(): vscode.ExtensionContext {
  return {
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
    },
  } as unknown as vscode.ExtensionContext;
}

const sampleCredentials = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "sync-bucket",
  region: "auto",
  prefix: "users/user-1/",
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  sessionToken: "session-token",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

describe("app-r2-storage", () => {
  beforeEach(async () => {
    vi.resetModules();
    showErrorMessageMock.mockReset();
    getAppSessionMock.mockReset();
    awsFetchMock.mockReset();
    const { clearR2CredentialsCache } = await import("../src/app-r2-storage.js");
    clearR2CredentialsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires app session to mint credentials", async () => {
    getAppSessionMock.mockResolvedValue(undefined);
    const { mintR2StorageCredentials } = await import("../src/app-r2-storage.js");

    const result = await mintR2StorageCredentials(makeContext());

    expect(result).toBeUndefined();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Log in to Cursor Sync to sync configs with the app."
    );
  });

  it("POST /v1/storage/credentials with Bearer token", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleCredentials,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { mintR2StorageCredentials } = await import("../src/app-r2-storage.js");
    const result = await mintR2StorageCredentials(makeContext(), { ttlSeconds: 900 });

    expect(result?.prefix).toBe("users/user-1/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8100/v1/storage/credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ ttlSeconds: 900 }),
      })
    );
  });

  it("caches credentials until expiresAt", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleCredentials,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getR2StorageCredentials } = await import("../src/app-r2-storage.js");
    const first = await getR2StorageCredentials(makeContext());
    const second = await getR2StorageCredentials(makeContext());

    expect(first?.accessKeyId).toBe("AKIA");
    expect(second?.accessKeyId).toBe("AKIA");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints when credentials are about to expire", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...sampleCredentials,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => sampleCredentials,
      });
    vi.stubGlobal("fetch", fetchMock);

    const { getR2StorageCredentials } = await import("../src/app-r2-storage.js");
    await getR2StorageCredentials(makeContext());
    await getR2StorageCredentials(makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns login message on 401", async () => {
    getAppSessionMock.mockResolvedValue("expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      })
    );

    const { mintR2StorageCredentials } = await import("../src/app-r2-storage.js");
    const result = await mintR2StorageCredentials(makeContext());

    expect(result).toBeUndefined();
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Log in to Cursor Sync to sync configs with the app."
    );
  });

  it("throws on 503 when R2 env is missing", async () => {
    getAppSessionMock.mockResolvedValue("jwt-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "storage unavailable",
      })
    );

    const { mintR2StorageCredentials } = await import("../src/app-r2-storage.js");

    await expect(mintR2StorageCredentials(makeContext())).rejects.toThrow(
      "App storage is unavailable (503)"
    );
  });

  it("buildScopedObjectKey rejects invalid sync keys", async () => {
    const { buildScopedObjectKey } = await import("../src/app-r2-storage.js");
    expect(() => buildScopedObjectKey("users/user-1/", "../other/settings.json")).toThrow(
      'Invalid sync key "../other/settings.json"'
    );
  });

  it("putR2Object signs PUT under scoped prefix", async () => {
    awsFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const { putR2Object } = await import("../src/app-r2-storage.js");
    await putR2Object(sampleCredentials, "cursor-user/settings.json", Buffer.from("{}"));

    expect(awsFetchMock).toHaveBeenCalledWith(
      "https://example.r2.cloudflarestorage.com/sync-bucket/users/user-1/cursor-user/settings.json",
      expect.objectContaining({
        method: "PUT",
        body: Buffer.from("{}"),
      })
    );
  });

  it("getR2Object returns undefined on 404", async () => {
    awsFetchMock.mockResolvedValue({ ok: false, status: 404 });

    const { getR2Object } = await import("../src/app-r2-storage.js");
    const result = await getR2Object(
      sampleCredentials,
      "cursor-user/settings.json"
    );

    expect(result).toBeUndefined();
  });
});
