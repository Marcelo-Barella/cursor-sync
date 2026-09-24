import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const appendLineMock = vi.fn();
const showMock = vi.fn();
const showErrorMessageMock = vi.fn();
const openExternalMock = vi.fn().mockResolvedValue(true);
const registerUriHandlerMock = vi.fn(() => ({ dispose: () => {} }));

const getAppApiUrlMock = vi.hoisted(() => vi.fn(() => "https://api.sync.bergamota.dev"));
const getAppWebsiteUrlMock = vi.hoisted(() =>
  vi.fn(() => "https://sync.bergamota.dev")
);

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: getAppApiUrlMock,
  getAppWebsiteUrl: getAppWebsiteUrlMock,
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      inspect: () => undefined,
    }),
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: (...args: unknown[]) => showErrorMessageMock(...args),
    showInputBox: vi.fn(),
    registerUriHandler: (...args: unknown[]) => registerUriHandlerMock(...args),
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
    openExternal: (...args: unknown[]) => openExternalMock(...args),
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

function latestUriHandler(): { handleUri: (uri: vscode.Uri) => void } {
  const registered = registerUriHandlerMock.mock.calls.at(-1)?.[0] as {
    handleUri: (uri: vscode.Uri) => void;
  };
  if (!registered) {
    throw new Error("URI handler was not registered");
  }
  return registered;
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

  it("rejects callback URIs that include token query params", async () => {
    const { parseAuthCallbackUriFromString } = await import("../src/app-auth.js");
    const uri = parseAuthCallbackUriFromString(
      "cursor://MarceloBarella.cursor-sync/auth?code=abc&token=jwt-leak",
      "MarceloBarella.cursor-sync",
      "cursor"
    );
    expect(uri).toBeUndefined();
  });
});

describe("app-auth sign-in URL and state", () => {
  beforeEach(() => {
    vi.resetModules();
    showErrorMessageMock.mockReset();
    openExternalMock.mockReset();
    openExternalMock.mockResolvedValue(true);
    registerUriHandlerMock.mockClear();
    getAppApiUrlMock.mockReset();
    getAppApiUrlMock.mockReturnValue("https://api.sync.bergamota.dev");
    getAppWebsiteUrlMock.mockReset();
    getAppWebsiteUrlMock.mockReturnValue("https://sync.bergamota.dev");
  });

  it("buildSignInUrl uses website sign-in path with redirect_uri and state", async () => {
    const { buildSignInUrl } = await import("../src/app-auth.js");
    const url = buildSignInUrl(
      "https://sync.bergamota.dev/",
      "cursor://MarceloBarella.cursor-sync/auth",
      "nonce-123"
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://sync.bergamota.dev/sign-in");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "cursor://MarceloBarella.cursor-sync/auth"
    );
    expect(parsed.searchParams.get("state")).toBe("nonce-123");
  });

  it("executeLoginToCursorSync opens configured website sign-in URL", async () => {
    const { executeLoginToCursorSync } = await import("../src/app-auth.js");
    await executeLoginToCursorSync({
      extension: { id: "MarceloBarella.cursor-sync" },
    } as never);

    expect(getAppWebsiteUrlMock).toHaveBeenCalled();
    expect(openExternalMock).toHaveBeenCalledTimes(1);
    const opened = String(openExternalMock.mock.calls[0]?.[0]);
    const parsed = new URL(opened);
    expect(parsed.pathname).toBe("/sign-in");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "cursor://MarceloBarella.cursor-sync/auth"
    );
    expect(parsed.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifyAndConsumeAuthState accepts a matching nonce once", async () => {
    const { storePendingAuthState, verifyAndConsumeAuthState } = await import(
      "../src/app-auth.js"
    );
    const now = 1_700_000_000_000;
    storePendingAuthState("expected-state", now);
    expect(verifyAndConsumeAuthState("expected-state", now + 1000)).toEqual({ ok: true });
    expect(verifyAndConsumeAuthState("expected-state", now + 2000)).toEqual({
      ok: false,
      message: "No login in progress. Start sign-in again.",
    });
  });

  it("verifyAndConsumeAuthState rejects missing state", async () => {
    const { storePendingAuthState, verifyAndConsumeAuthState } = await import(
      "../src/app-auth.js"
    );
    storePendingAuthState("expected-state");
    expect(verifyAndConsumeAuthState(undefined)).toEqual({
      ok: false,
      message: "Login callback did not include state.",
    });
  });

  it("verifyAndConsumeAuthState rejects mismatched state", async () => {
    const { storePendingAuthState, verifyAndConsumeAuthState } = await import(
      "../src/app-auth.js"
    );
    storePendingAuthState("expected-state");
    expect(verifyAndConsumeAuthState("other-state")).toEqual({
      ok: false,
      message: "Login state did not match. Start sign-in again.",
    });
  });

  it("verifyAndConsumeAuthState rejects expired state", async () => {
    const { storePendingAuthState, verifyAndConsumeAuthState, AUTH_STATE_TTL_MS } =
      await import("../src/app-auth.js");
    const now = 1_700_000_000_000;
    storePendingAuthState("expected-state", now);
    expect(
      verifyAndConsumeAuthState("expected-state", now + AUTH_STATE_TTL_MS + 1)
    ).toEqual({
      ok: false,
      message: "Login state expired. Start sign-in again.",
    });
  });

  it("formatAuthCallbackUri uses host uriScheme (vscode vs cursor)", async () => {
    const { formatAuthCallbackUri } = await import("../src/app-auth.js");
    expect(formatAuthCallbackUri("cursor", "MarceloBarella.cursor-sync")).toBe(
      "cursor://MarceloBarella.cursor-sync/auth"
    );
    expect(formatAuthCallbackUri("vscode", "MarceloBarella.cursor-sync")).toBe(
      "vscode://MarceloBarella.cursor-sync/auth"
    );
  });

  it("handleAuthCallbackUri rejects callback when state does not match", async () => {
    const { storePendingAuthState, registerAppAuthUriHandler, consumePendingAuthCallback } =
      await import("../src/app-auth.js");
    storePendingAuthState("expected-state");
    const ctx = {
      extension: { id: "MarceloBarella.cursor-sync" },
      subscriptions: [] as unknown[],
    };
    registerAppAuthUriHandler(ctx as never);
    consumePendingAuthCallback(ctx as never);

    latestUriHandler().handleUri(
      makeAuthUri("MarceloBarella.cursor-sync", "code=abc&state=wrong-state")
    );

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Login state did not match. Start sign-in again."
    );
  });

  it("handleAuthCallbackUri rejects token in callback URL", async () => {
    const { storePendingAuthState, registerAppAuthUriHandler, consumePendingAuthCallback } =
      await import("../src/app-auth.js");
    storePendingAuthState("expected-state");
    const ctx = {
      extension: { id: "MarceloBarella.cursor-sync" },
      subscriptions: [] as unknown[],
    };
    registerAppAuthUriHandler(ctx as never);
    consumePendingAuthCallback(ctx as never);

    latestUriHandler().handleUri(
      makeAuthUri(
        "MarceloBarella.cursor-sync",
        "code=abc&state=expected-state&token=must-not-use"
      )
    );

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      "Login callback must not include a token in the URL. Complete sign-in with the one-time code flow."
    );
  });
});

describe("app-auth session storage", () => {
  beforeEach(() => {
    vi.resetModules();
    appendLineMock.mockReset();
    showMock.mockReset();
    registerUriHandlerMock.mockClear();
    getAppApiUrlMock.mockReset();
    getAppApiUrlMock.mockReturnValue("https://api.sync.bergamota.dev");
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

    const token = await exchangeCodeForSessionToken(
      "https://api.sync.bergamota.dev",
      "one-time"
    );
    expect(token).toBe("jwt-session-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sync.bergamota.dev/auth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "one-time" }),
      })
    );

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

  it("completeLoginWithCode exchanges code against configured apiUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "jwt-from-api" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { storePendingAuthState, registerAppAuthUriHandler, consumePendingAuthCallback } =
      await import("../src/app-auth.js");
    storePendingAuthState("state-ok");
    const ctx = makeSecretsContext();
    const extCtx = {
      ...ctx,
      extension: { id: "MarceloBarella.cursor-sync" },
      subscriptions: [] as unknown[],
    };
    registerAppAuthUriHandler(extCtx as never);
    consumePendingAuthCallback(extCtx as never);

    latestUriHandler().handleUri(
      makeAuthUri("MarceloBarella.cursor-sync", "code=exchange-me&state=state-ok")
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(getAppApiUrlMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sync.bergamota.dev/auth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "exchange-me" }),
      })
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
