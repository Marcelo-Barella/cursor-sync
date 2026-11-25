import * as fs from "node:fs/promises";
import { symlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { scanWithDiskProbes } from "../src/app-config-disk-probe.js";
import {
  formatPerFileSyncHeldNotice,
  formatPullSkippedFilesNotice,
  perFileHeldReasonForKey,
} from "../src/app-storage-delete-guard.js";
import { formatPullPartialToast } from "../src/sync-destination.js";
import type { LocalConfigFileScan } from "../src/app-config-local-scan.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const showWarningMessageMock = vi.hoisted(() => vi.fn());

function emptyScan(overrides: Partial<LocalConfigFileScan> = {}): LocalConfigFileScan {
  return {
    checksums: {},
    unreadableKeys: new Set(),
    excludedKeys: new Set(),
    oversizeKeys: new Set(),
    symlinkKeys: new Set(),
    underSymlinkedDirKeys: new Set(),
    symlinkedFolderLabels: {},
    enoentKeys: new Set(),
    provablyAbsentKeys: new Set(),
    skippedUnknownKeys: new Set(),
    untrackedKeys: new Set(),
    absentEligibleKeys: new Set(),
    deletesAllowed: true,
    enumeratedCount: 0,
    rootsHealthy: true,
    trackingScopeMismatch: false,
    deleteBlockedRootPrefixes: new Set(),
    ...overrides,
  };
}

describe("M3 fresh device disk probe held reasons", () => {
  let tmp = "";
  let context: vscode.ExtensionContext;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("labels oversize, excluded, and under-symlinked-dir without baseline", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs28-m3-"));
    const dotCursor = path.join(tmp, ".cursor");
    const rulesDir = path.join(dotCursor, "rules");
    const outsideRules = path.join(tmp, "outside-rules");
    await fs.mkdir(outsideRules, { recursive: true });
    await fs.mkdir(rulesDir, { recursive: true });
    symlinkSync(outsideRules, path.join(dotCursor, "rules-linked"), "dir");

    const oversizePath = path.join(dotCursor, "snippets", "z.json");
    await fs.mkdir(path.dirname(oversizePath), { recursive: true });
    await fs.writeFile(oversizePath, "x".repeat(700_000), "utf8");

    const excludedPath = path.join(dotCursor, "commands", "r8.md");
    await fs.mkdir(path.dirname(excludedPath), { recursive: true });
    await fs.writeFile(excludedPath, "# excluded\n", "utf8");

    const underLinkPath = path.join(dotCursor, "rules-linked", "r8.mdc");
    await fs.writeFile(underLinkPath, "body", "utf8");

    const symlinkPath = path.join(dotCursor, "rules", "r8.mdc");
    await fs.writeFile(symlinkPath, "sym", "utf8");

    vi.spyOn(await import("../src/paths.js"), "resolveSyncRoots").mockReturnValue({
      cursorUser: path.join(tmp, "user"),
      dotCursor,
    });
    const enumConfig = {
      cursorUserGlobs: ["**/*"],
      dotCursorGlobs: ["**/*"],
      excludeGlobs: ["commands/**"],
      maxBytes: 512_000,
    };
    vi.spyOn(await import("../src/paths.js"), "getSyncEnumerationConfig").mockReturnValue(
      enumConfig as ReturnType<typeof import("../src/paths.js").getSyncEnumerationConfig>
    );

    context = {
      globalStorageUri: { fsPath: path.join(tmp, "gs") },
      globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => ({ dispose: () => {} }),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const base = emptyScan();
    const keys = [
      "dot-cursor/snippets/z.json",
      "dot-cursor/commands/r8.md",
      "dot-cursor/rules-linked/inner.mdc",
      "dot-cursor/rules/r8.mdc",
    ];
    const scan = await scanWithDiskProbes(context, base, keys, {
      baselineLocalKeys: [],
    });

    expect(perFileHeldReasonForKey("dot-cursor/snippets/z.json", scan)).toBe("oversize");
    expect(perFileHeldReasonForKey("dot-cursor/commands/r8.md", scan)).toBe("excluded");
    expect(perFileHeldReasonForKey("dot-cursor/rules-linked/inner.mdc", scan)).toBe(
      "under_symlinked_dir"
    );
    expect(perFileHeldReasonForKey("dot-cursor/rules/r8.mdc", scan)).not.toBe("unreadable");

    const held = [
      "dot-cursor/snippets/z.json",
      "dot-cursor/commands/r8.md",
      "dot-cursor/rules-linked/inner.mdc",
    ];
    const notice = formatPerFileSyncHeldNotice(scan, held);
    expect(notice).toMatch(/oversize.*z\.json/);
    expect(notice).toMatch(/excluded.*commands\/r8\.md/);
    expect(notice).toMatch(/inside symlinked folder rules-linked/);
    expect(notice).not.toMatch(/unreadable.*z\.json/);
  });
});

describe("M4 pull summary and skip reasons", () => {
  it("partial toast counts skipped files in the total", () => {
    const msg = formatPullPartialToast(1, 2, 0, "cursor-sync-storage", 1);
    expect(msg).toBe("Pulled 1 of 2 from Cursor Sync storage, 0 missing, 1 skipped");
  });

  it("names per-file skip reason for symlink", () => {
    const scan = emptyScan({
      symlinkKeys: new Set(["dot-cursor/r8.mdc"]),
      skippedUnknownKeys: new Set(["dot-cursor/r8.mdc"]),
    });
    expect(formatPullSkippedFilesNotice(scan, ["dot-cursor/r8.mdc"])).toBe(
      "Pull skipped 1 file (symlink): dot-cursor/r8.mdc"
    );
  });
});

describe("REGRESSION scheduled root-only skip detection", () => {
  it("treats per-file skips as not root-only", async () => {
    const { __appConfigsPullTestHooks } = await import("../src/app-configs.js");
    const scan = emptyScan({
      deleteBlockedRootPrefixes: new Set(["dot-cursor/"]),
      symlinkKeys: new Set(["dot-cursor/symlink.md"]),
      skippedUnknownKeys: new Set(["dot-cursor/a.md", "dot-cursor/symlink.md"]),
    });
    const rootOnly = __appConfigsPullTestHooks.isScheduledRootOnlyPullSkip(
      scan,
      ["dot-cursor/a.md", "dot-cursor/symlink.md"],
      []
    );
    expect(rootOnly).toBe(false);
    const onlyRoot = __appConfigsPullTestHooks.isScheduledRootOnlyPullSkip(
      scan,
      ["dot-cursor/a.md"],
      []
    );
    expect(onlyRoot).toBe(true);
  });
});

describe("M6 root ensure warning on manual pull", () => {
  it("manual trigger always shows root warning even after scheduled fingerprint", async () => {
    const vscodeMod = await import("vscode");
    vi.spyOn(vscodeMod.window, "showWarningMessage").mockImplementation(showWarningMessageMock);

    const context = {
      globalStorageUri: { fsPath: "/tmp/gs" },
      globalState: {
        get: (key: string) =>
          key === "cursorSync.appStorage.rootEnsureFailuresWarned"
            ? [{ rootPath: "/tmp/.cursor", fingerprint: "EEXIST" }]
            : undefined,
        update: vi.fn().mockResolvedValue(undefined),
        keys: () => [],
      },
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => ({ dispose: () => {} }),
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const { __appConfigsPullTestHooks } = await import("../src/app-configs.js");
    const { warnRootEnsureFailuresOnce } = __appConfigsPullTestHooks;
    showWarningMessageMock.mockClear();
    await warnRootEnsureFailuresOnce(
      context,
      [{ rootPath: "/tmp/.cursor", message: "EEXIST: already exists" }],
      "manual",
      { appendLine: vi.fn() } as unknown as import("vscode").OutputChannel
    );
    expect(showWarningMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("Pull skipped sync root(s): /tmp/.cursor")
    );
  });
});
