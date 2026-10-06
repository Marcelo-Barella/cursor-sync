import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { sidebarSnapshotHasComposerData } from "./chat-partial-state.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows, resolveChatsRoot } = __chatPersistenceInternals;

export type VerifyStatus = "OK" | "WARN" | "FAIL" | "SKIP" | "PENDING";

export interface VerifyCheck {
  name: string;
  status: VerifyStatus;
  detail: string;
}

export const ACTIVATION_DIR = path.join(os.homedir(), ".cursor", "import-activation");
const ACTIVATION_PENDING_PATH = path.join(ACTIVATION_DIR, "pending.json");
const ACTIVATION_RESULT_PATH = path.join(ACTIVATION_DIR, "result.json");

export interface VerifyIoDeps {
  fileExists: (filePath: string) => Promise<boolean>;
  readTextFile: (filePath: string) => Promise<string>;
  querySqliteRows: (
    dbPath: string,
    sql: string,
    opts?: { retries?: number }
  ) => Promise<Array<Record<string, unknown>>>;
  globalStateDbPath: () => string;
  chatsRoot: () => string;
}

function defaultDeps(): VerifyIoDeps {
  return {
    fileExists: async (filePath: string) => {
      try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
      } catch {
        return false;
      }
    },
    readTextFile: (filePath: string) => fs.readFile(filePath, "utf8"),
    querySqliteRows,
    globalStateDbPath: () => {
      const { cursorUser } = resolveExtensionSyncRoots();
      return path.join(cursorUser, "globalStorage", "state.vscdb");
    },
    chatsRoot: resolveChatsRoot,
  };
}

export function formatVerifyCheckLine(check: VerifyCheck): string {
  if (check.detail) {
    return `[${check.status}] ${check.name}: ${check.detail}`;
  }
  return `[${check.status}] ${check.name}`;
}

export function formatVerifyReport(
  checks: VerifyCheck[],
  options?: { jsonLines?: boolean }
): string {
  if (options?.jsonLines) {
    return checks
      .map((c) =>
        JSON.stringify({ check: c.name, status: c.status, detail: c.detail })
      )
      .join("\n");
  }
  return checks.map(formatVerifyCheckLine).join("\n");
}

export function verifyChecksAllOk(checks: VerifyCheck[]): boolean {
  return checks.every((c) => c.status !== "FAIL");
}

async function readComposerHeaderEntry(
  deps: VerifyIoDeps,
  dbPath: string,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  if (!(await deps.fileExists(dbPath))) {
    return null;
  }
  const rows = await deps.querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerHeaders' LIMIT 1",
    { retries: 3 }
  );
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.value;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const allComposers = (data as Record<string, unknown>).allComposers;
  if (!Array.isArray(allComposers)) {
    return null;
  }
  for (const entry of allComposers) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).composerId === conversationId
    ) {
      return entry as Record<string, unknown>;
    }
  }
  return null;
}

async function countStoreDbBlobs(
  deps: VerifyIoDeps,
  storePath: string
): Promise<number | null> {
  if (!(await deps.fileExists(storePath))) {
    return null;
  }
  try {
    const tables = await deps.querySqliteRows(
      storePath,
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const names = new Set(
      tables
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string")
    );
    if (!names.has("blobs")) {
      return 0;
    }
    const countRows = await deps.querySqliteRows(
      storePath,
      "SELECT COUNT(*) AS n FROM blobs"
    );
    const n = countRows[0]?.n;
    if (typeof n === "number") {
      return n;
    }
    if (typeof n === "string" && /^\d+$/.test(n)) {
      return parseInt(n, 10);
    }
    return 0;
  } catch {
    return null;
  }
}

async function composerDataHasConversationKey(
  deps: VerifyIoDeps,
  dbPath: string,
  conversationId: string
): Promise<boolean | null> {
  if (!(await deps.fileExists(dbPath))) {
    return null;
  }
  const rows = await deps.querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerData' LIMIT 1"
  );
  if (rows.length === 0) {
    return false;
  }
  const raw = rows[0]?.value;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const val = (data as Record<string, unknown>)[conversationId];
  if (val == null) {
    return false;
  }
  if (typeof val === "object" && !Array.isArray(val)) {
    return Object.keys(val as object).length > 0;
  }
  return false;
}

export interface VerifyImportVisibilityOptions {
  expectRichComposerData?: boolean;
  expectStore?: boolean;
  deps?: Partial<VerifyIoDeps>;
}

export async function verifyImportVisibility(
  conversationId: string,
  workspaceContext: WorkspaceContext | null,
  options: VerifyImportVisibilityOptions = {}
): Promise<VerifyCheck[]> {
  const deps = { ...defaultDeps(), ...options.deps };
  const expectRichComposerData = options.expectRichComposerData ?? false;
  const expectStore = options.expectStore ?? false;
  const checks: VerifyCheck[] = [];

  const chatsKey = workspaceContext?.chatsWorkspaceKey ?? null;
  let storePath: string | null = null;
  if (chatsKey) {
    storePath = path.join(
      deps.chatsRoot(),
      chatsKey,
      conversationId,
      "store.db"
    );
    if (await deps.fileExists(storePath)) {
      const blobN = await countStoreDbBlobs(deps, storePath);
      if (blobN === null) {
        checks.push({
          name: "store.db",
          status: "WARN",
          detail: `${storePath} exists but blob count unreadable`,
        });
      } else if (blobN > 0) {
        checks.push({
          name: "store.db",
          status: "OK",
          detail: `${chatsKey}/${conversationId} (${blobN} blobs)`,
        });
      } else {
        checks.push({
          name: "store.db",
          status: "FAIL",
          detail: `${storePath} has 0 blobs`,
        });
      }
    } else if (expectStore) {
      checks.push({
        name: "store.db",
        status: "FAIL",
        detail: `missing at ~/.cursor/chats/${chatsKey}/${conversationId}/`,
      });
    } else {
      checks.push({
        name: "store.db",
        status: "SKIP",
        detail: `no file at ~/.cursor/chats/${chatsKey}/${conversationId}/`,
      });
    }
  } else if (expectStore) {
    checks.push({
      name: "store.db",
      status: "FAIL",
      detail: "workspace context missing",
    });
  }

  const globalDb = deps.globalStateDbPath();
  const ent = await readComposerHeaderEntry(deps, globalDb, conversationId);
  if (ent === null) {
    checks.push({
      name: "global.composerHeaders",
      status: "FAIL",
      detail: "sidebar row missing in globalStorage/state.vscdb",
    });
  } else {
    const wiRaw = ent.workspaceIdentifier;
    const wi =
      wiRaw && typeof wiRaw === "object" && !Array.isArray(wiRaw)
        ? (wiRaw as Record<string, unknown>)
        : {};
    const wiId = wi.id;
    const uri = wi.uri;
    const fp =
      uri && typeof uri === "object" && !Array.isArray(uri)
        ? (uri as Record<string, unknown>).fsPath
        : undefined;
    const expected = workspaceContext?.folderFsPath;
    const expectedId = workspaceContext?.workspaceStorageId;

    if (!wiId) {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "FAIL",
        detail: "id not stamped on header",
      });
    } else if (expectedId && wiId !== expectedId) {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "FAIL",
        detail: `id=${String(wiId)} expected workspaceStorage id ${expectedId}`,
      });
    } else {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "OK",
        detail: `id=${String(wiId)}`,
      });
    }

    if (expected && fp !== expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "FAIL",
        detail: `uri.fsPath=${JSON.stringify(fp)} expected ${JSON.stringify(expected)}`,
      });
    } else if (expected && fp === expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "OK",
        detail: String(fp ?? ""),
      });
    } else if (expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "FAIL",
        detail: "uri.fsPath missing on header",
      });
    }

    checks.push({
      name: "global.composerHeaders",
      status: "OK",
      detail: conversationId,
    });
  }

  if (workspaceContext) {
    const { cursorUser } = resolveExtensionSyncRoots();
    const wsDb = path.join(
      cursorUser,
      "workspaceStorage",
      workspaceContext.workspaceStorageId,
      "state.vscdb"
    );
    const entW = await readComposerHeaderEntry(deps, wsDb, conversationId);
    const wsLabel = `workspace.composerHeaders(${workspaceContext.workspaceStorageId})`;
    if (entW === null) {
      checks.push({
        name: wsLabel,
        status: "WARN",
        detail: "missing (global row may still be enough)",
      });
    } else {
      checks.push({
        name: wsLabel,
        status: "OK",
        detail: conversationId,
      });
    }

    for (const [label, db] of [
      ["global", globalDb],
      ["workspace", wsDb],
    ] as const) {
      const hasKey = await composerDataHasConversationKey(
        deps,
        db,
        conversationId
      );
      if (expectRichComposerData) {
        if (hasKey) {
          checks.push({
            name: `${label}.composerData[${conversationId}]`,
            status: "OK",
            detail: "per-composer payload present",
          });
        } else {
          checks.push({
            name: `${label}.composerData[${conversationId}]`,
            status: "FAIL",
            detail: "bundle sidebar had composerData but disk key missing",
          });
        }
      } else if (hasKey) {
        checks.push({
          name: `${label}.composerData[${conversationId}]`,
          status: "OK",
          detail: "per-composer payload present",
        });
      }
    }
  }

  return checks;
}

export interface VerifyActivationChecksOptions {
  deps?: Partial<VerifyIoDeps>;
  pendingPath?: string;
  resultPath?: string;
}

export async function verifyActivationChecks(
  conversationId: string,
  options: VerifyActivationChecksOptions = {}
): Promise<VerifyCheck[]> {
  const deps = { ...defaultDeps(), ...options.deps };
  const pendingPath = options.pendingPath ?? ACTIVATION_PENDING_PATH;
  const resultPath = options.resultPath ?? ACTIVATION_RESULT_PATH;
  const checks: VerifyCheck[] = [];

  let pendingCid: string | null = null;
  if (await deps.fileExists(pendingPath)) {
    try {
      const pending = JSON.parse(await deps.readTextFile(pendingPath)) as Record<
        string,
        unknown
      >;
      const raw = pending.composerId;
      if (typeof raw === "string") {
        pendingCid = raw.trim();
      }
      if (!pendingCid) {
        const partial = pending.partialState;
        if (partial && typeof partial === "object" && !Array.isArray(partial)) {
          const pc = (partial as Record<string, unknown>).composerId;
          if (typeof pc === "string") {
            pendingCid = pc.trim();
          }
        }
      }
      if (pendingCid === conversationId) {
        checks.push({
          name: "activation.pending",
          status: "OK",
          detail: `staged for ${conversationId}`,
        });
      } else if (pendingCid) {
        checks.push({
          name: "activation.pending",
          status: "WARN",
          detail: `pending composerId=${JSON.stringify(pendingCid)} (expected ${conversationId})`,
        });
      } else {
        checks.push({
          name: "activation.pending",
          status: "WARN",
          detail: "pending.json has no composerId",
        });
      }
    } catch {
      checks.push({
        name: "activation.pending",
        status: "WARN",
        detail: "pending.json unreadable",
      });
    }
  } else {
    checks.push({
      name: "activation.pending",
      status: "SKIP",
      detail: "no pending.json",
    });
  }

  let resultCid: string | null = null;
  let resultOk = false;
  if (await deps.fileExists(resultPath)) {
    try {
      const result = JSON.parse(await deps.readTextFile(resultPath)) as Record<
        string,
        unknown
      >;
      if (result.ok !== false) {
        const raw = result.composerId;
        if (typeof raw === "string" && raw.trim()) {
          resultCid = raw.trim();
          resultOk = true;
        }
      }
      if (resultOk && resultCid === conversationId) {
        checks.push({
          name: "activation.result",
          status: "OK",
          detail: `composerId=${resultCid}`,
        });
      } else if (resultCid) {
        checks.push({
          name: "activation.result",
          status: "WARN",
          detail: `composerId=${JSON.stringify(resultCid)} (expected ${conversationId})`,
        });
      } else {
        checks.push({
          name: "activation.result",
          status: "WARN",
          detail: "result.json missing composerId",
        });
      }
    } catch {
      checks.push({
        name: "activation.result",
        status: "WARN",
        detail: "result.json unreadable",
      });
    }
  } else {
    checks.push({
      name: "activation.result",
      status: "PENDING",
      detail:
        "awaiting IDE hook, CURSOR_COMPOSER_BRIDGE_COMMAND, or --bridge-wait-result",
    });
  }

  if (resultOk && resultCid === conversationId) {
    checks.push({
      name: "activation.status",
      status: "OK",
      detail: "completed",
    });
  } else if (pendingCid === conversationId) {
    checks.push({
      name: "activation.status",
      status: "PENDING",
      detail: "manifest staged; IDE activation not confirmed",
    });
  } else {
    checks.push({
      name: "activation.status",
      status: "SKIP",
      detail: "no matching activation artifacts for this conversation",
    });
  }

  return checks;
}

export interface RunDiskAndActivationVerifyOptions {
  bundle?: ChatBundle | Record<string, unknown> | null;
  postActivate?: boolean;
  expectRichComposerData?: boolean;
  expectStore?: boolean;
  deps?: Partial<VerifyIoDeps>;
  pendingPath?: string;
  resultPath?: string;
}

export async function runDiskAndActivationVerify(
  conversationId: string,
  workspaceContext: WorkspaceContext | null,
  options: RunDiskAndActivationVerifyOptions = {}
): Promise<VerifyCheck[]> {
  const bundle = options.bundle;
  let expectRich = options.expectRichComposerData;
  let expectStore = options.expectStore;
  if (bundle != null) {
    if (expectRich === undefined) {
      expectRich = sidebarSnapshotHasComposerData(bundle, conversationId);
    }
    if (expectStore === undefined) {
      const snap = (bundle as Record<string, unknown>).storeSnapshot;
      expectStore =
        !!snap &&
        typeof snap === "object" &&
        !Array.isArray(snap) &&
        !!(snap as Record<string, unknown>).content;
    }
  }
  const checks = await verifyImportVisibility(conversationId, workspaceContext, {
    expectRichComposerData: expectRich ?? false,
    expectStore: expectStore ?? false,
    deps: options.deps,
  });
  if (options.postActivate) {
    const activation = await verifyActivationChecks(conversationId, {
      deps: options.deps,
      pendingPath: options.pendingPath,
      resultPath: options.resultPath,
    });
    checks.push(...activation);
  }
  return checks;
}
