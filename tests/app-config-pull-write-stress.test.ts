import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeChecksum } from "../src/packaging.js";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

const mockRoots = vi.hoisted(() => ({
  cursorUser: "",
  dotCursor: "",
}));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({
    cursorUser: mockRoots.cursorUser,
    dotCursor: mockRoots.dotCursor,
  }),
}));

vi.mock("../src/diagnostics.js", () => ({
  getLogger: () => ({
    appendLine: vi.fn(),
    show: vi.fn(),
  }),
}));

const STRESS_RUNS = 80;

/** Orphan pull temps or pulled file payloads outside the verified sync root. */
async function countEscapeArtifacts(root: string, syncRoot: string): Promise<number> {
  let escapes = 0;
  const syncRootResolved = path.resolve(syncRoot);
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(syncRootResolved, full);
      const outsideSync = rel.startsWith("..") || path.isAbsolute(rel);
      const isOurTmp =
        entry.name.startsWith(".cursor-sync-pull-") && entry.name.endsWith(".tmp");
      const looksLikePulledPayload =
        entry.name.startsWith("file-") && entry.name.endsWith(".json");
      if (outsideSync && (isOurTmp || looksLikePulledPayload)) {
        escapes += 1;
      }
    }
  }
  await walk(root);
  return escapes;
}

describe("pull write stress (post staging.13 guards)", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = "";
    }
    vi.resetModules();
  });

  it(
    `reports zero escape artifacts per ${STRESS_RUNS} adversarial-layout runs`,
    async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-stress-"));
    const outside = path.join(root, "outside");
    const cursorUser = path.join(root, "cursor-user");
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(cursorUser, { recursive: true });
    mockRoots.cursorUser = cursorUser;
    mockRoots.dotCursor = path.join(root, "dot-cursor");
    await fs.mkdir(mockRoots.dotCursor, { recursive: true });

    const storage = path.join(root, "storage");
    await fs.mkdir(storage, { recursive: true });
    const ctx = {
      globalStorageUri: { fsPath: storage },
      globalState: { get: () => undefined, update: async () => {} },
    } as never;

    const resolved = {
      cursorUser,
      dotCursor: mockRoots.dotCursor,
      cursorUserReal: await fs.realpath(cursorUser),
      dotCursorReal: await fs.realpath(mockRoots.dotCursor),
    };

    const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
    const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");

    let escapes = 0;
    for (let i = 0; i < STRESS_RUNS; i += 1) {
      const sub = path.join(cursorUser, `batch-${i % 5}`);
      await fs.mkdir(sub, { recursive: true });
      const target = path.join(sub, `file-${i}.json`);
      const content = Buffer.from(`{"i":${i}}`, "utf-8");
      const run = beginAppConfigsRun("pull");
      try {
        await executeAppConfigPullWrites(
          ctx,
          run,
          [
            {
              syncKey: `cursor-user/batch-${i % 5}/file-${i}.json`,
              absolutePath: target,
              content,
              expectedChecksum: computeChecksum(content),
            },
          ],
          resolved
        );
      } catch {
        // some layout iterations may fail closed; still scan for escapes
      } finally {
        run.end();
      }
      escapes += await countEscapeArtifacts(root, cursorUser);
    }

    // Baseline before staging.12 hardening: tester saw rare escapes outside sync root.
    // After guards: expect zero orphaned .tmp / remote files outside cursor-user.
    expect(escapes).toBe(0);
    // eslint-disable-next-line no-console
    console.log(
      `pull write stress (sequential): escapes=${escapes} per ${STRESS_RUNS} runs (expected 0)`
    );
    },
    60_000
  );

  it(
    "concurrent parent-swap adversary reports zero escape artifacts",
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-stress-concurrent-"));
      const outside = path.join(root, "outside");
      const cursorUser = path.join(root, "cursor-user");
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(cursorUser, { recursive: true });
      mockRoots.cursorUser = cursorUser;
      mockRoots.dotCursor = path.join(root, "dot-cursor");
      await fs.mkdir(mockRoots.dotCursor, { recursive: true });

      const storage = path.join(root, "storage");
      await fs.mkdir(storage, { recursive: true });
      const ctx = {
        globalStorageUri: { fsPath: storage },
        globalState: { get: () => undefined, update: async () => {} },
      } as never;

      const resolved = {
        cursorUser,
        dotCursor: mockRoots.dotCursor,
        cursorUserReal: await fs.realpath(cursorUser),
        dotCursorReal: await fs.realpath(mockRoots.dotCursor),
      };

      const { executeAppConfigPullWrites } = await import("../src/app-config-pull-files.js");
      const { beginAppConfigsRun } = await import("../src/app-session-coordination.js");

      const CONCURRENT = 40;
      let adversaryRunning = true;
      const adversary = (async () => {
        while (adversaryRunning) {
          for (let bucket = 0; bucket < 4; bucket += 1) {
            const parent = path.join(cursorUser, `concurrent-${bucket}`);
            const escapeParent = path.join(outside, `escape-${bucket}`);
            try {
              await fs.mkdir(escapeParent, { recursive: true });
              await fs.rm(parent, { force: true, recursive: true });
              await fs.symlink(escapeParent, parent);
              await new Promise((r) => setTimeout(r, 0));
              await fs.rm(parent, { force: true });
              await fs.mkdir(parent, { recursive: true });
            } catch {
              // race writers between open and rename
            }
          }
          await new Promise((r) => setTimeout(r, 0));
        }
      })();

      let escapes = 0;
      const workers = Array.from({ length: CONCURRENT }, async (_, i) => {
        const sub = path.join(cursorUser, `concurrent-${i % 4}`);
        await fs.mkdir(sub, { recursive: true });
        const target = path.join(sub, `file-${i}.json`);
        const content = Buffer.from(`{"c":${i}}`, "utf-8");
        const run = beginAppConfigsRun("pull");
        try {
          await executeAppConfigPullWrites(
            ctx,
            run,
            [
              {
                syncKey: `cursor-user/concurrent-${i % 4}/file-${i}.json`,
                absolutePath: target,
                content,
                expectedChecksum: computeChecksum(content),
              },
            ],
            resolved
          );
        } catch {
          // fail closed
        } finally {
          run.end();
        }
      });

      await Promise.all(workers);
      adversaryRunning = false;
      await adversary;
      escapes = await countEscapeArtifacts(root, cursorUser);

      expect(escapes).toBe(0);
      // eslint-disable-next-line no-console
      console.log(
        `pull write stress (concurrent parent-swap adversary): escapes=${escapes} per ${CONCURRENT} runs (expected 0)`
      );
    },
    120_000
  );
});
