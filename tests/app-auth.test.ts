import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const appendLineMock = vi.fn();
const showMock = vi.fn();

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
  Uri: {
    parse: (value: string) => {
      const match = value.match(/^([^:/?#]+):\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?/);
      if (!match) {
        throw new Error(`Invalid URI: ${value}`);
      }
      const uri = {
        scheme: match[1],
        authority: match[2],
        path: match[3] ?? "",
        query: match[4] ?? "",
        toString() {
          const query = this.query ? `?${this.query}` : "";
          return `${this.scheme}://${this.authority}${this.path}${query}`;
        },
        with(parts: { authority?: string; scheme?: string; path?: string; query?: string }) {
          return {
            ...this,
            scheme: parts.scheme ?? this.scheme,
            authority: parts.authority ?? this.authority,
            path: parts.path ?? this.path,
            query: parts.query ?? this.query,
            toString: this.toString,
            with: this.with,
          };
        },
      };
      return uri;
    },
  },
  env: {
    uriScheme: "cursor",
    asExternalUri: async (uri: { with: (parts: { authority?: string }) => unknown; toString: () => string }) =>
      uri.with({ authority: "marcelobarella.cursor-sync" }),
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: appendLineMock,
    show: showMock,
  }),
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

function makeSecretsContext(options?: {
  store?: (key: string, value: string) => Promise<void>;
  get?: (key: string) => Promise<string | undefined>;
  delete?: (key: string) => Promise<void>;
}) {
  const secretsStore = new Map<string, string>();
  return {
    secrets: {
      get: options?.get ?? (async (key: string) => secretsStore.get(key)),
      store:
        options?.store ??
        (async (key: string, value: string) => {
          secretsStore.set(key, value);
        }),
      delete:
        options?.delete ??
        (async (key: string) => {
          secretsStore.delete(key);
        }),
    },
    _secretsStore: secretsStore,
  };
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

  it("matches auth callback when authority casing differs", async () => {
    const { isAuthCallbackUri } = await import("../src/app-auth.js");
    const extensionId = "MarceloBarella.cursor-sync";
    const uri = makeAuthUri("marcelobarella.cursor-sync", "code=1");
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

  it("finds auth callback in --open-url argv", async () => {
    const { findAuthCallbackUriInArgv, extractAuthCodeFromUri } = await import(
      "../src/app-auth.js"
    );
    const uri = findAuthCallbackUriInArgv(
      ["cursor", "--open-url", "cursor://marcelobarella.cursor-sync/auth?code=argv-code"],
      "MarceloBarella.cursor-sync",
      "cursor"
    );
    expect(uri).toBeDefined();
    expect(extractAuthCodeFromUri(uri!)).toBe("argv-code");
  });

  it("buildAuthRedirectUri preserves context.extension.id authority casing", async () => {
    const { buildAuthRedirectUri } = await import("../src/app-auth.js");
    const redirectUri = await buildAuthRedirectUri({
      extension: { id: "MarceloBarella.cursor-sync" },
    } as never);
    expect(redirectUri).toBe("cursor://MarceloBarella.cursor-sync/auth");
  });
});

describe("app-auth session storage", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockReset();
    showMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores session token from POST /auth/token", async () => {
    const secretsStore = new Map<string, string>();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-session-token" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exchangeCodeForSessionToken, setAppSession, getAppSession } =
      await import("../src/app-auth.js");
    const ctx = makeSecretsContext({
      store: async (key, value) => {
        secretsStore.set(key, value);
      },
      get: async (key) => secretsStore.get(key),
    });

    const token = await exchangeCodeForSessionToken("http://localhost:8100", "one-time");
    expect(token).toBe("jwt-session-token");

    await setAppSession(ctx as never, token);
    expect(await getAppSession(ctx as never)).toBe("jwt-session-token");
    expect(appendLineMock).toHaveBeenCalledWith(
      expect.stringContaining("App session: storing to SecretStorage")
    );
    expect(appendLineMock).toHaveBeenCalledWith(
      expect.stringContaining("App session: SecretStorage store completed")
    );

    vi.unstubAllGlobals();
  });

  it("uses in-memory session when secrets.store throws", async () => {
    const { setAppSession, getAppSession } = await import("../src/app-auth.js");
    const ctx = makeSecretsContext({
      store: async () => {
        throw new Error("encryptString failed");
      },
    });

    await setAppSession(ctx as never, "jwt-in-memory");
    expect(await getAppSession(ctx as never)).toBe("jwt-in-memory");
    expect(appendLineMock).toHaveBeenCalled();
  });

  it("uses in-memory session when secrets.store hangs", async () => {
    vi.useFakeTimers();
    const { setAppSession, getAppSession } = await import("../src/app-auth.js");
    const ctx = makeSecretsContext({
      store: () => new Promise(() => {}),
    });

    const pending = setAppSession(ctx as never, "jwt-hung");
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(await getAppSession(ctx as never)).toBe("jwt-hung");
    expect(appendLineMock).toHaveBeenCalled();
  });

  it("clears in-memory session on clearAppSession", async () => {
    const { setAppSession, getAppSession, clearAppSession } = await import(
      "../src/app-auth.js"
    );
    const ctx = makeSecretsContext({
      store: async () => {
        throw new Error("encryptString failed");
      },
    });

    await setAppSession(ctx as never, "jwt-clear-me");
    await clearAppSession(ctx as never);
    expect(await getAppSession(ctx as never)).toBeUndefined();
  });
});
