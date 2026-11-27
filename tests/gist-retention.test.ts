import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseGistManifest, planGistFileRetention } from "../src/gist-retention.js";
import type { Manifest } from "../src/types.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

function manifestWith(
  files: Manifest["files"]
): Manifest {
  return {
    schemaVersion: 1,
    syncProfileName: "default",
    createdAt: "2026-11-27T00:00:00.000Z",
    sourceMachineId: "test",
    sourceOS: "linux",
    files,
  };
}

describe("parseGistManifest", () => {
  it("accepts schemaVersion 1 objects and rejects invalid payloads", () => {
    const valid = manifestWith({
      "cursor-user/settings.json": { checksum: "abc", sizeBytes: 2 },
    });
    expect(parseGistManifest(JSON.stringify(valid))?.files).toEqual(valid.files);
    expect(parseGistManifest(undefined)).toBeUndefined();
    expect(parseGistManifest("{")).toBeUndefined();
    expect(parseGistManifest(JSON.stringify({ schemaVersion: 2, files: {} }))).toBeUndefined();
  });
});

describe("planGistFileRetention", () => {
  it("deletes only mapped gist files whose local path is gone", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-retention-"));
    const cursorUser = path.join(tmp, "cursorUser");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.writeFile(path.join(cursorUser, "settings.json"), "{}");

    const decision = await planGistFileRetention(
      [
        "manifest.json",
        "cursor-user--settings.json",
        "cursor-user--keybindings.json",
        "orphan.txt",
      ],
      new Set(["manifest.json"]),
      { cursorUser, dotCursor: path.join(tmp, "dotCursor") },
      manifestWith({
        "cursor-user/settings.json": { checksum: "keep-me", sizeBytes: 2 },
        "cursor-user/keybindings.json": { checksum: "drop-me", sizeBytes: 2 },
      })
    );

    expect(decision.filesToDelete).toEqual({
      "cursor-user--keybindings.json": null,
    });
    expect(decision.retainedChecksums).toEqual({
      "cursor-user/settings.json": "keep-me",
    });
    expect(decision.retainedManifestFiles["cursor-user/settings.json"]).toEqual({
      checksum: "keep-me",
      sizeBytes: 2,
    });
    expect(decision.retainedManifestFiles["cursor-user/keybindings.json"]).toBeUndefined();

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not mark uploading gist names for deletion", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-retention-up-"));
    const decision = await planGistFileRetention(
      ["manifest.json", "cursor-user--settings.json"],
      new Set(["manifest.json", "cursor-user--settings.json"]),
      {
        cursorUser: path.join(tmp, "cursorUser"),
        dotCursor: path.join(tmp, "dotCursor"),
      },
      manifestWith({
        "cursor-user/settings.json": { checksum: "new", sizeBytes: 2 },
      })
    );
    expect(decision.filesToDelete).toEqual({});
    expect(decision.retainedChecksums).toEqual({});
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
