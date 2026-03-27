import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("transcripts", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-transcripts-" + Date.now());

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("discoverProjects", () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(tmpDir, "home-user-dev-cursor-sync"), { recursive: true });
      await fs.mkdir(path.join(tmpDir, "home-user-dev-private-cursor-sync"), { recursive: true });
      await fs.mkdir(path.join(tmpDir, "home-user-projects-webapp-a1b2c3d4"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "not-a-dir.txt"), "file");
    });

    it("lists project directories with labels", async () => {
      const { discoverProjects } = await import("../src/transcripts.js");
      const projects = await discoverProjects(tmpDir);
      expect(projects.length).toBe(3);
      const labels = projects.map((p) => p.label);
      expect(labels).toContain("home-user-dev-cursor-sync");
      expect(labels).toContain("home-user-dev-private-cursor-sync");
      expect(labels).toContain("home-user-projects-webapp");
    });

    it("returns empty array for missing directory", async () => {
      const { discoverProjects } = await import("../src/transcripts.js");
      const projects = await discoverProjects(path.join(tmpDir, "nonexistent"));
      expect(projects).toEqual([]);
    });

    it("excludes non-directory entries", async () => {
      const { discoverProjects } = await import("../src/transcripts.js");
      const projects = await discoverProjects(tmpDir);
      const names = projects.map((p) => p.folderName);
      expect(names).not.toContain("not-a-dir.txt");
    });
  });

  describe("enumerateTranscriptFiles", () => {
    const projectDir = path.join(tmpDir, "test-project");

    beforeEach(async () => {
      const transcriptsDir = path.join(projectDir, "agent-transcripts");
      const convDir = path.join(transcriptsDir, "aaa-bbb-ccc");
      const subagentDir = path.join(convDir, "subagents");

      await fs.mkdir(subagentDir, { recursive: true });
      await fs.writeFile(path.join(convDir, "aaa-bbb-ccc.jsonl"), '{"role":"user"}\n');
      await fs.writeFile(path.join(subagentDir, "sub-111.jsonl"), '{"role":"agent"}\n');
      await fs.writeFile(path.join(convDir, "notes.txt"), "not a jsonl");
    });

    it("finds .jsonl files under agent-transcripts", async () => {
      const { enumerateTranscriptFiles } = await import("../src/transcripts.js");
      const files = await enumerateTranscriptFiles(projectDir, 1024 * 1024);
      const rels = files.map((f) => f.relativePath);
      expect(rels).toContain("aaa-bbb-ccc/aaa-bbb-ccc.jsonl");
      expect(rels).toContain("aaa-bbb-ccc/subagents/sub-111.jsonl");
      expect(rels).not.toContain("aaa-bbb-ccc/notes.txt");
    });

    it("skips files exceeding max size", async () => {
      const largePath = path.join(projectDir, "agent-transcripts", "aaa-bbb-ccc", "aaa-bbb-ccc.jsonl");
      await fs.writeFile(largePath, Buffer.alloc(100, "x"));

      const { enumerateTranscriptFiles } = await import("../src/transcripts.js");
      const files = await enumerateTranscriptFiles(projectDir, 50);
      const rels = files.map((f) => f.relativePath);
      expect(rels).not.toContain("aaa-bbb-ccc/aaa-bbb-ccc.jsonl");
    });

    it("returns empty for project without agent-transcripts dir", async () => {
      const emptyProject = path.join(tmpDir, "empty-project");
      await fs.mkdir(emptyProject, { recursive: true });

      const { enumerateTranscriptFiles } = await import("../src/transcripts.js");
      const files = await enumerateTranscriptFiles(emptyProject, 1024 * 1024);
      expect(files).toEqual([]);
    });

    it("sets projectKey from directory name", async () => {
      const { enumerateTranscriptFiles } = await import("../src/transcripts.js");
      const files = await enumerateTranscriptFiles(projectDir, 1024 * 1024);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(f.projectKey).toBe("test-project");
      }
    });
  });

  describe("resolveProjectsRoot", () => {
    it("returns path under ~/.cursor/projects", async () => {
      const { resolveProjectsRoot } = await import("../src/transcripts.js");
      const root = resolveProjectsRoot();
      expect(root).toBe(path.join(os.homedir(), ".cursor", "projects"));
    });
  });
});
