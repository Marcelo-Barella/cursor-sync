import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_LOGIN_API_BASE_OVERRIDE_KEY,
  APP_SESSION_EXPIRED_KEY,
  APP_SESSION_USER_EMAIL_KEY,
  APP_STORAGE_E2E_KEY_SECRET,
} from "../src/app-session-state.js";
import { APP_SESSION_SECRET } from "../src/app-auth.js";
import { APPEARANCE_THEME_SETTING_KEY } from "../src/sidebar/appearance-theme.js";
import { saveSyncState } from "../src/diagnostics.js";
import type { SyncState } from "../src/types.js";

const showWarningMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();
const refreshSidebarMock = vi.hoisted(() => vi.fn());
const clearR2CredentialsCacheMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ status: 404 }));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: refreshSidebarMock,
}));

vi.mock("../src/app-r2-storage.js", () => ({
  clearR2CredentialsCache: clearR2CredentialsCacheMock,
}));

vi.mock("../src/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diagnostics.js")>();
  return {
    ...actual,
    getLogger: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
    }),
  };
});

const appearanceTheme = "dark";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (section === "cursorSync" && key === APPEARANCE_THEME_SETTING_KEY) {
          return appearanceTheme as T;
        }
        return defaultValue;
      },
      inspect: () => undefined,
      update: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: (...args: unknown[]) => showWarningMessageMock(...args),
    showInformationMessage: (...args: unknown[]) => showInformationMessageMock(...args),
    showErrorMessage: (...args: unknown[]) => showErrorMessageMock(...args),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (progress: { report: (v: { message?: string }) => void }) => Promise<void>
      ) => task({ report: vi.fn() })
    ),
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
    }),
  },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
}));

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function makeContext(globalStateData: Record<string, unknown> = {}) {
  const secretsStore = new Map<string, string>();
  const state = { ...globalStateData };
  const globalStorage = path.join(os.tmpdir(), `cursor-sync-logout-${Date.now()}-${Math.random()}`);
  return {
    secrets: {
      get: async (key: string) => secretsStore.get(key),
      store: async (key: string, value: string) => {
        secretsStore.set(key, value);
      },
      delete: async (key: string) => {
        secretsStore.delete(key);
      },
    },
    globalState: {
      get: <T>(key: string) => state[key] as T,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          delete state[key];
        } else {
          state[key] = value;
        }
      },
    },
    globalStorageUri: { fsPath: globalStorage },
    _secretsStore: secretsStore,
    _state: state,
  };
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("executeLogoutAppSession", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    showWarningMessageMock.mockReset();
    showInformationMessageMock.mockReset();
    refreshSidebarMock.mockReset();
    clearR2CredentialsCacheMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ status: 404 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears session secrets and global session keys while preserving theme and sync baseline", async () => {
    const token = makeJwt({ email: "user@example.com", sub: "user-1" });
    const ctx = makeContext({
      [APP_SESSION_USER_EMAIL_KEY]: "user@example.com",
      [APP_SESSION_EXPIRED_KEY]: true,
      [APP_LOGIN_API_BASE_OVERRIDE_KEY]: "https://api.example.test",
    });
    await ctx.secrets.store(APP_SESSION_SECRET, token);
    await ctx.secrets.store(APP_STORAGE_E2E_KEY_SECRET, "e2e-material");

    const syncState: SyncState = {
      gistId: "abc123",
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      localChecksums: { "settings.json": "checksum" },
      remoteChecksums: { "settings.json": "checksum" },
    };
    await saveSyncState(ctx as never, syncState);

    showWarningMessageMock.mockResolvedValue("Log out");

    const { setAppSession, getAppSession, executeLogoutAppSession } = await import(
      "../src/app-auth.js"
    );
    await setAppSession(ctx as never, token);

    await executeLogoutAppSession(ctx as never);

    expect(await getAppSession(ctx as never)).toBeUndefined();
    expect(ctx._secretsStore.has(APP_SESSION_SECRET)).toBe(false);
    expect(ctx._secretsStore.has(APP_STORAGE_E2E_KEY_SECRET)).toBe(false);
    expect(ctx._state[APP_SESSION_USER_EMAIL_KEY]).toBeUndefined();
    expect(ctx._state[APP_SESSION_EXPIRED_KEY]).toBeUndefined();
    expect(ctx._state[APP_LOGIN_API_BASE_OVERRIDE_KEY]).toBeUndefined();
    expect(clearR2CredentialsCacheMock).toHaveBeenCalled();

    const { loadSyncState } = await import("../src/diagnostics.js");
    const afterSync = await loadSyncState(ctx as never);
    expect(afterSync?.gistId).toBe("abc123");

    const { readAppearanceThemePreference } = await import("../src/sidebar/appearance-theme.js");
    expect(readAppearanceThemePreference()).toBe("dark");

    expect(refreshSidebarMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(showInformationMessageMock).toHaveBeenCalledWith(
      "Logged out of Cursor Sync storage."
    );
  });

  it("stays signed in when SecretStorage delete fails", async () => {
    const token = makeJwt({ email: "user@example.com" });
    const ctx = makeContext();
    await ctx.secrets.store(APP_SESSION_SECRET, token);
    ctx.secrets.delete = async () => {
      throw new Error("keychain locked");
    };

    showWarningMessageMock.mockResolvedValue("Log out");
    const { getAppSession, executeLogoutAppSession } = await import("../src/app-auth.js");
    await executeLogoutAppSession(ctx as never);

    expect(await getAppSession(ctx as never)).toBe(token);
    expect(showInformationMessageMock).not.toHaveBeenCalledWith(
      "Logged out of Cursor Sync storage."
    );
    expect(showErrorMessageMock).toHaveBeenCalled();
  });

  it("does nothing when the user cancels the confirm dialog", async () => {
    const token = makeJwt({ email: "user@example.com" });
    const ctx = makeContext();
    showWarningMessageMock.mockResolvedValue(undefined);

    const { setAppSession, getAppSession, executeLogoutAppSession } = await import(
      "../src/app-auth.js"
    );
    await setAppSession(ctx as never, token);
    await executeLogoutAppSession(ctx as never);

    expect(await getAppSession(ctx as never)).toBe(token);
    expect(clearR2CredentialsCacheMock).not.toHaveBeenCalled();
    expect(refreshSidebarMock).not.toHaveBeenCalled();
  });

  it("7c: does not release an in-flight gist sync latch", async () => {
    const token = makeJwt({ email: "user@example.com" });
    const ctx = makeContext();
    await ctx.secrets.store(APP_SESSION_SECRET, token);
    showWarningMessageMock.mockResolvedValue("Log out");

    const { tryBeginSyncOperation, isPushLocked, endSyncOperation } = await import(
      "../src/sync-operation.js"
    );
    const { executeLogoutAppSession } = await import("../src/app-auth.js");

    tryBeginSyncOperation();
    expect(isPushLocked()).toBe(true);
    await executeLogoutAppSession(ctx as never);
    expect(isPushLocked()).toBe(true);
    endSyncOperation();
  });
});

describe("package logout command", () => {
  it("declares cursorSync.app.logout", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.app.logout"
    );
    expect(command).toEqual({
      command: "cursorSync.app.logout",
      title: "Cursor Sync: Log out of Cursor Sync Storage",
    });
  });
});
