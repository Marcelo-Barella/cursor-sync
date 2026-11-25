import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const showQuickPickMock = vi.fn();

vi.mock("vscode", () => ({
  window: { showQuickPick: showQuickPickMock, showErrorMessage: vi.fn() },
}));

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    runSqliteScript: vi.fn(),
    resolveStateDbCandidates: vi.fn().mockResolvedValue([]),
    resolveChatsRoot: vi.fn(),
    escapeSqlLiteral: vi.fn((s: string) => s),
    mergeComposerHeadersChain: vi.fn(),
    mergeComposerDataAdditive: vi.fn(),
    deriveComposerHeadersPayloadFromSidebarSnapshot: vi.fn(),
    stampWorkspaceIdentifierOnPayload: vi.fn(),
    isExecFileTimeoutError: vi.fn(),
    querySqliteRows: vi.fn(),
  },
}));

describe("import gist workspace picker labels", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "import-gist-labels-"));
    vi.resetModules();
  });

  it("promptForTargetWorkspace uses workspaceQuickPickLabel", async () => {
    const { md5FolderKey } = await import("../src/chat-workspace-context.js");
    const folder = path.join(tmpRoot, "repo");
    await fs.mkdir(folder, { recursive: true });
    const key = md5FolderKey(path.resolve(folder));
    const cursorUser = path.join(tmpRoot, "Cursor", "User");
    const wsDir = path.join(cursorUser, "workspaceStorage", "id1");
    await fs.mkdir(wsDir, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(path.resolve(folder)).href }),
      "utf8"
    );
    const { PATHS_MOCK_USER_LABELS } = await import("./paths-mock-labels.js");
    vi.doMock("../src/paths.js", () => ({
      ...PATHS_MOCK_USER_LABELS,
      resolveSyncRoots: () => ({ cursorUser, dotCursor: path.join(tmpRoot, ".cursor") }),
    }));
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpRoot };
    });
    vi.resetModules();
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { __importGistTranscriptsTestUtils } = await import("../src/import-gist-transcripts.js");
    await __importGistTranscriptsTestUtils.promptForTargetWorkspace([
      { name: key, fullPath: path.join(tmpRoot, ".cursor", "chats", key) },
    ]);
    const firstPickArg = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    expect(firstPickArg[0]!.label).toBe(path.join("~", "repo"));
    expect(firstPickArg[0]!.description).toBe(key);
  });
});
