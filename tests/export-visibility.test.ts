import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("export gist visibility and copy", () => {
  const exportSrc = readFileSync(path.join(root, "src/export.ts"), "utf-8");
  const transcriptsSrc = [
    readFileSync(path.join(root, "src/transcripts.ts"), "utf-8"),
    readFileSync(path.join(root, "src/transcripts-export.ts"), "utf-8"),
  ].join("\n");
  const exportGistChatSrc = readFileSync(path.join(root, "src/export-gist-chat.ts"), "utf-8");

  it("settings export calls createGist with two arguments only (no public flag)", () => {
    expect(exportSrc).toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Export"\s*\)/s
    );
    expect(exportSrc).not.toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Export"\s*,\s*true/s
    );
  });

  it("transcript export calls createGist with two arguments only (no public flag)", () => {
    expect(transcriptsSrc).toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Agent Transcripts Export"\s*\)/s
    );
    expect(transcriptsSrc).not.toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Agent Transcripts Export"\s*,\s*true/s
    );
  });

  it("chat export calls createGist with two arguments only (no public flag)", () => {
    expect(exportGistChatSrc).toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Chat Export"\s*\)/s
    );
    expect(exportGistChatSrc).not.toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*"Cursor Sync - Chat Export"\s*,\s*true/s
    );
  });

  it("settings export UI copy describes private gist and link caveat", () => {
    expect(exportSrc).toContain("Select files to export to a private Gist");
    expect(exportSrc).toContain("Creating private Gist...");
    expect(exportSrc).toContain("Export successful! Private Gist at");
    expect(exportSrc).toContain("wrapGistFilesForUpload");
  });

  it("transcript export UI copy describes private gist and link caveat", () => {
    expect(transcriptsSrc).toContain("This will create a private Gist with");
    expect(transcriptsSrc).toContain("not listed on your public profile");
    expect(transcriptsSrc).toContain("anyone with the direct URL can still open it");
    expect(transcriptsSrc).toContain("Creating private Gist with transcripts...");
    expect(transcriptsSrc).toContain("Transcript export successful! Private Gist:");
    expect(transcriptsSrc).toContain("encrypted");
  });

  it("chat export UI copy describes private gist and link caveat", () => {
    expect(exportGistChatSrc).toContain("Creating private Gist...");
    expect(exportGistChatSrc).toContain("Export successful! Chat");
    expect(exportGistChatSrc).toContain("private Gist");
    expect(exportGistChatSrc).toContain("sync encryption");
  });

  it("multi-chat export success copy mentions private gist and link caveat", () => {
    expect(exportGistChatSrc).toContain("${bundles.length} chats in private Gist");
    expect(exportGistChatSrc).toContain("sync encryption");
  });
});
