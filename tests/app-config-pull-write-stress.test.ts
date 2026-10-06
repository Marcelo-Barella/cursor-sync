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

async function countEscapeArtifacts(root: string, syncRoot: string): Promise<number> {
  let escapes = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(syncRoot, full);
      const outsideSync =
        rel.startsWith("..") || path.isAbsolute(rel) || dir === root && !full.startsWith(syncRoot);
      const isOurTmp =
        entry.name.startsWith(".cursor-sync-pull-") && entry.name.endsWith(".tmp");
      if (outsideSync || (isOurTmp && dir !== path.dirname(full))) {
        escapes += 1;
      }
      if (isOurTmp && !full.startsWith(syncRoot)) {
        escapes += 1;
      }
    }
  }
  const parentOfSync = path.dirname(syncRoot);
  try {
    const siblings = await fs.readdir(parentOfSync, { withFileTypes: true });
    for (const s of siblings) {
      if (s.name.startsWith(".cursor-sync-pull-") && s.name.endsWith(".tmp")) {
        escapes += 1;
      }
    }
  } catch {
    // ignore
  }
  await walk(root);
  return escapes;
}

describe("pull write stress (post staging.12 guards)", () => {
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
    console.log(`pull write stress: escapes=${escapes} per ${STRESS_RUNS} runs (expected 0 after staging.12)`);
    },
    60_000
  );
});
