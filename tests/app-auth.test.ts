import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        key === "appApiUrl" ? ("http://localhost:8100" as T) : defaultValue,
    }),
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
  },
}));

function makeAuthUri(
  extensionId: string,
  query: string,
  path = "/auth"
): vscode.Uri {
  return {
    scheme: "cursor",
    authority: extensionId,
    path,
    query,
  } as vscode.Uri;
}

describe("app-auth URI helpers", () => {
  it("extracts code from callback query", async () => {
    const { extractAuthCodeFromUri } = await import("../src/app-auth.js");
    const uri = makeAuthUri("MarceloBarella.cursor-sync", "code=abc123&state=ignored");
    expect(extractAuthCodeFromUri(uri)).toBe("abc123");
  });

  it("returns undefined when code is missing", async () => {
    const { extractAuthCodeFromUri } = await import("../src/app-auth.js");
    const uri = makeAuthUri("MarceloBarella.cursor-sync", "state=only");
    expect(extractAuthCodeFromUri(uri)).toBeUndefined();
  });

  it("returns undefined when code is empty", async () => {
    const { extractAuthCodeFromUri } = await import("../src/app-auth.js");
    const uri = makeAuthUri("MarceloBarella.cursor-sync", "code=");
    expect(extractAuthCodeFromUri(uri)).toBeUndefined();
  });

  it("trims whitespace from code", async () => {
    const { extractAuthCodeFromUri } = await import("../src/app-auth.js");
    const uri = makeAuthUri("MarceloBarella.cursor-sync", "code=%20xyz%20");
    expect(extractAuthCodeFromUri(uri)).toBe("xyz");
  });

  it("matches auth callback path for extension id", async () => {
    const { isAuthCallbackUri } = await import("../src/app-auth.js");
    const extensionId = "MarceloBarella.cursor-sync";
    const uri = makeAuthUri(extensionId, "code=1");
    expect(isAuthCallbackUri(uri, extensionId)).toBe(true);
  });

  it("rejects wrong path", async () => {
    const { isAuthCallbackUri } = await import("../src/app-auth.js");
    const extensionId = "MarceloBarella.cursor-sync";
    const uri = makeAuthUri(extensionId, "code=1", "/other");
    expect(isAuthCallbackUri(uri, extensionId)).toBe(false);
  });

  it("rejects wrong authority", async () => {
    const { isAuthCallbackUri } = await import("../src/app-auth.js");
    const uri = makeAuthUri("other.publisher", "code=1");
    expect(isAuthCallbackUri(uri, "MarceloBarella.cursor-sync")).toBe(false);
  });
});

describe("app-auth token exchange", () => {
  it("stores session token from POST /auth/token", async () => {
    const secretsStore = new Map<string, string>();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-session-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForSessionToken, setAppSession, getAppSession } =
      await import("../src/app-auth.js");
    const ctx = {
      secrets: {
        get: async (key: string) => secretsStore.get(key),
        store: async (key: string, value: string) => {
          secretsStore.set(key, value);
        },
        delete: async (key: string) => {
          secretsStore.delete(key);
        },
      },
    };

    const token = await exchangeCodeForSessionToken("http://localhost:8100", "one-time");
    expect(token).toBe("jwt-session-token");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8100/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "one-time" }),
    });

    await setAppSession(ctx as never, token);
    expect(await getAppSession(ctx as never)).toBe("jwt-session-token");

    vi.unstubAllGlobals();
  });
});
