import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureSyncRootsForFreshPull,
  syncKeyUnderFailedRoot,
} from "../src/app-config-sync-path-safety.js";

const tmpRoot = `/tmp/cursor-sync-s21-${Date.now()}`;

describe("staging.21 sync root creation failures (b12/b16)", () => {
  beforeEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("b12: dangling symlink root fails in isolation without throwing", async () => {
    const parent = path.join(tmpRoot, "parent");
    const dotCursor = path.join(parent, "dotcursor");
    await fs.mkdir(parent, { recursive: true });
    await fs.symlink(path.join(tmpRoot, "missing-dir"), dotCursor, "dir");
    const failures = await ensureSyncRootsForFreshPull(
      { cursorUser: path.join(tmpRoot, "user"), dotCursor },
      ["dot-cursor/rules/r.mdc"],
      []
    );
    expect(failures.length).toBe(1);
    expect(failures[0]?.prefix).toBe("dot-cursor/");
    expect(syncKeyUnderFailedRoot("dot-cursor/rules/r.mdc", failures)).toBeDefined();
    expect(syncKeyUnderFailedRoot("cursor-user/settings.json", failures)).toBeUndefined();
  });

  it("b16: parent symlink blocks root mkdir without throwing", async () => {
    const realParent = path.join(tmpRoot, "real-parent");
    const linkParent = path.join(tmpRoot, "link-parent");
    const dotCursor = path.join(linkParent, "dotcursor");
    await fs.mkdir(realParent, { recursive: true });
    await fs.symlink(realParent, linkParent, "dir");
    const failures = await ensureSyncRootsForFreshPull(
      { cursorUser: path.join(tmpRoot, "user"), dotCursor },
      ["dot-cursor/a.txt"],
      []
    );
    expect(failures.some((f) => f.prefix === "dot-cursor/")).toBe(true);
  });

  it("cursor-user root can still be created when dot-cursor root fails", async () => {
    const parent = path.join(tmpRoot, "p");
    const dotCursor = path.join(parent, "dotcursor");
    const cursorUser = path.join(tmpRoot, "cursor-user");
    await fs.mkdir(parent, { recursive: true });
    await fs.symlink(path.join(tmpRoot, "nope"), dotCursor, "dir");
    const failures = await ensureSyncRootsForFreshPull(
      { cursorUser, dotCursor },
      ["cursor-user/settings.json", "dot-cursor/x.md"],
      []
    );
    expect(failures.length).toBe(1);
    await fs.access(cursorUser);
  });
});
