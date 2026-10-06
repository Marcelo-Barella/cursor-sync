import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const showInformationMessageMock = vi.fn();
const showErrorMessageMock = vi.fn();

vi.mock("vscode", () => ({
  extensions: {
    all: [],
    getExtension: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) => {
        if (key === "safeMode") return false as T;
        if (key === "syncProfileName") return "default" as T;
        return defaultValue;
      },
    }),
  },
  window: {
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({ appendLine: vi.fn(), show: vi.fn() }),
  addSyncHistoryEntry: vi.fn().mockResolvedValue(undefined),
}));

const probePaths = vi.hoisted(() => {
  const tmpRoot = `/tmp/cursor-sync-f3-${Date.now()}`;
  return {
    tmpRoot,
    cursorUser: `${tmpRoot}/cursor-user`,
    dotCursor: `${tmpRoot}/dot-cursor`,
    outside: `${tmpRoot}/outside-target.md`,
  };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/paths.js")>();
  const { cursorUser, dotCursor } = probePaths;
  return {
    ...actual,
    resolveSyncRoots: () => ({
      cursorUser,
      dotCursor,
    }),
    getSyncEnumerationConfig: () => ({
      enabledPaths: ["**/*"],
      excludeGlobs: [],
      maxFileSizeKB: 512,
      maxBytes: 512 * 1024,
      cursorUserGlobs: ["**/*"],
      dotCursorGlobs: ["**/*"],
    }),
    isSyncKeyExcludedByConfig: () => false,
  };
});

const putR2ObjectMock = vi.hoisted(() => vi.fn().mockResolvedValue(200));

vi.mock("../src/app-auth.js", () => ({
  getAppSession: vi.fn().mockResolvedValue("jwt"),
}));

vi.mock("../src/app-storage-sync-declines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-storage-sync-declines.js")>();
  return {
    ...actual,
    pruneResolvedDeclines: vi.fn().mockResolvedValue(undefined),
    filterPushKeysRespectingDeclines: async (_c: unknown, keys: string[]) => keys,
    loadSyncDeclineStore: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("../src/app-storage-baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app-storage-baseline.js")>();
  return {
    ...actual,
    loadAppStorageBaseline: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      accountKey: "acct",
      destination: "cursor-sync-storage",
      remoteUpdatedAt: "2026-01-01T00:00:00.000Z",
      localChecksums: {
        "cursor-user/settings.json": "a",
        "dot-cursor/link.md": "b",
      },
      remoteChecksums: {
        "cursor-user/settings.json": "a",
        "dot-cursor/link.md": "b",
      },
    }),
    updateAppStorageBaselineAfterSync: vi.fn().mockResolvedValue(undefined),
    baselineHasEntries: () => true,
  };
});

vi.mock("../src/app-session-identity.js", () => ({
  appStorageAccountKey: () => "acct",
}));

vi.mock("../src/config/urls.js", () => ({
  getAppApiUrl: () => "http://localhost:8100",
}));

vi.mock("../src/app-r2-storage.js", () => ({
  getR2StorageCredentials: vi.fn().mockResolvedValue({ prefix: "users/u/" }),
  putR2Object: putR2ObjectMock,
  getR2Object: vi.fn(),
  deleteR2Object: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
  return {
    extensionUri: { fsPath: "/ext" },
    globalState: { get: vi.fn(), update: vi.fn() },
    secrets: { get: vi.fn(), store: vi.fn() },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

const { tmpRoot, cursorUser, dotCursor, outside } = probePaths;

describe("manual push skip notice (F3)", () => {
  beforeEach(async () => {
    vi.resetModules();
    showInformationMessageMock.mockReset();
    putR2ObjectMock.mockClear();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    await fs.writeFile(
      path.join(cursorUser, "settings.json"),
      '{"sync":true}\n',
      "utf8"
    );
    await fs.writeFile(outside, "outside content\n", "utf8");
    await fs.symlink(outside, path.join(dotCursor, "link.md"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          payload: {
            schemaVersion: 1,
            manifest: {
              schemaVersion: 1,
              syncProfileName: "default",
              createdAt: "2026-01-01T00:00:00.000Z",
              sourceMachineId: "m",
              sourceOS: "linux",
              files: {
                "cursor-user/settings.json": { checksum: "a", sizeBytes: 1 },
                "dot-cursor/link.md": { checksum: "b", sizeBytes: 1 },
              },
            },
            files: {
              "cursor-user/settings.json": { checksum: "a", sizeBytes: 1 },
              "dot-cursor/link.md": { checksum: "b", sizeBytes: 1 },
            },
          },
          updated_at: "2026-01-02T00:00:00.000Z",
        }),
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("shows Pushed N, skipped M with symlink name from real disk probe", async () => {
    const { executePushAppConfigs } = await import("../src/app-configs.js");
    const ok = await executePushAppConfigs(makeContext(), { trigger: "manual" });
    if (!ok) {
      throw new Error(
        `push failed: ${showErrorMessageMock.mock.calls.map((c) => c[0]).join(" | ")}`
      );
    }
    expect(ok).toBe(true);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).match(/Pushed 1 file\(s\), skipped 1/)
      )
    ).toBe(true);
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("dot-cursor/link.md")
      )
    ).toBe(true);
  });
});
