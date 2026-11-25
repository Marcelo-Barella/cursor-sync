import * as vscode from "vscode";
import { USER_LABEL_DOT_CURSOR, USER_LABEL_DOT_CURSOR_CHATS, USER_LABEL_DOT_CURSOR_PROJECTS, USER_LABEL_HOME_TILDE_PREFIX } from "./paths.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { systemTmpDir } from "./os-runtime.js";
import { getLogger } from "./diagnostics.js";
import { pruneOldBackups } from "./rollback.js";
import { __chatPersistenceInternals } from "./transcripts.js";
import {
  chatManifestFromBundle,
  hydrateGoldenStoreTemplate,
} from "./store-template-hydrate.js";
import {
  discoverProjects,
  findProjectMatchingOpenWorkspaceFolder,
} from "./transcripts.js";
import {
  folderToProjectKey,
  requireWorkspaceContext,
  buildChatsKeyToFolderMap,
} from "./chat-workspace-context.js";
import { emitChatImportProgress } from "./chat-progress-events.js";
import { resolveExtensionSyncRoots } from "./sync-roots.js";
import {
  pingServerProbe,
  runPostImportActivation,
} from "./chat-import-activate.js";
import {
  mergeFidelitySummaries,
  parsePythonInspectStdout,
  summarizeBundleFidelity,
} from "./chat-bundle-fidelity.js";
import {
  resolveTransportChatScript,
  runPythonBundleInspect,
  runPythonDiskImport,
} from "./chat-transport-scripts.js";
import {
  formatVerifyCheckLine,
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyActivationChecks,
  verifyChecksAllOk,
  type VerifyCheck,
} from "./chat-import-verify.js";
import { pickImportWorkspaceFolder } from "./chat-import-ux.js";
import { humanWorkspaceLabel, projectQuickPickLabel } from "./chat-workspace-label.js";
import { parseChatBundleOrCollection } from "./chat-bundle-format.js";
import {
  fidelityFieldsForImportHistory,
  publishImportFidelitySummary,
} from "./sidebar/chats-tab.js";
import { recordImport as recordImportEntry } from "./sidebar/import-history.js";
import type { ChatBundle, LoadChatResult, RestoreChatBundleOptions } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { enrichBundleWithLiveDiskKv } from "./chat-disk-kv-export.js";
import {
  applyImmediateSidebarWriteback,
  queueSidebarWriteback,
} from "./chat-import-sidebar-writeback.js";
const { resolveChatsRoot } = __chatPersistenceInternals;

function parseSidebarMergedFromPythonOutput(pyText: string): boolean {
  const match = pyText.match(/sidebar_merged=(true|false)/i);
  if (match?.[1]?.toLowerCase() === "true") {
    return true;
  }
  if (/Merged composer state into/i.test(pyText)) {
    return true;
  }
  if (/No sidebarSnapshot|sidebar merge skipped/i.test(pyText)) {
    return false;
  }
  return false;
}

function sidebarVisibleOnDiskFromVerify(checks: VerifyCheck[]): boolean {
  const globalHeaders = checks.find((c) => c.name === "global.composerHeaders");
  if (globalHeaders?.status === "OK") {
    return true;
  }
  const wsHeaders = checks.find((c) => c.name.startsWith("workspace.composerHeaders"));
  return wsHeaders?.status === "OK";
}

let pythonInterpreterMemo: string | null | undefined;

export async function ensurePythonReady(): Promise<string> {
  if (pythonInterpreterMemo !== undefined) {
    if (pythonInterpreterMemo === null) {
      throw new Error(
        "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
      );
    }
    return pythonInterpreterMemo;
  }
  const config = vscode.workspace.getConfiguration("cursorSync");
  const configured = config.get<string>("chatImport.pythonPath")?.trim();
  const candidates = configured ? [configured] : ["python3", "python"];
  for (const cand of candidates) {
    try {
      const { registerConfiguredAbsolutePythonPath, spawnSyncCapture } = await import(
        "./os-runtime.js"
      );
      registerConfiguredAbsolutePythonPath(cand);
      const res = spawnSyncCapture(cand, ["--version"], { encoding: "utf-8" });
      if (res.status === 0) {
        pythonInterpreterMemo = cand;
        return cand;
      }
    } catch { /* try next */ }
  }
  pythonInterpreterMemo = null;
  throw new Error(
    "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
  );
}

export function logChatRestoreDebug(line: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] [chat-restore-debug] ${line}`);
}

export function composerPayloadDebug(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "absent";
  }
  const list = payload.allComposers;
  if (!Array.isArray(list)) {
    return "present keys=" + Object.keys(payload).join(",");
  }
  const ids = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c))
    .map((c) => (typeof c.composerId === "string" ? c.composerId : ""))
    .filter((id) => id.length > 0);
  return `allComposers=${list.length} composerIds=[${ids.join(",")}]`;
}

export function bundleArtifactsDebug(bundle: ChatBundle): string {
  const tfSummary =
    bundle.transcriptFiles.length === 0
      ? "none"
      : bundle.transcriptFiles
          .map((t) => `${path.basename(t.relativePath)}:${t.sizeBytes}b`)
          .join(",");
  const store = bundle.storeSnapshot
    ? `present ${bundle.storeSnapshot.sizeBytes}b src=${bundle.storeSnapshot.sourceWorkspaceKey}`
    : "absent";
  const sidebar = bundle.sidebarSnapshot
    ? `present keys=${Object.keys(bundle.sidebarSnapshot).join(",")}`
    : "absent";
  return `transcriptFiles=${bundle.transcriptFiles.length} [${tfSummary}] storeSnapshot=${store} sidebarSnapshot=${sidebar}`;
}

async function resolveImportProjectMapping(
  sourceProjectKeys: string[],
  folderFsPath: string
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  if (sourceProjectKeys.length === 0) {
    return mapping;
  }

  const localProjects = await discoverProjects();
  const encoded = folderToProjectKey(folderFsPath);
  let targetKey =
    localProjects.find((p) => path.resolve(p.fullPath) === path.resolve(folderFsPath))
      ?.folderName ??
    localProjects.find((p) => p.folderName === encoded)?.folderName;

  if (!targetKey) {
    const openFolders = vscode.workspace.workspaceFolders;
    const openMatchesDest =
      openFolders?.some((wf) => path.resolve(wf.uri.fsPath) === path.resolve(folderFsPath)) ??
      false;
    const matched = openMatchesDest
      ? findProjectMatchingOpenWorkspaceFolder(localProjects, openFolders)
      : undefined;
    targetKey = matched?.folderName ?? encoded;
  }

  for (const sourceKey of sourceProjectKeys) {
    mapping.set(sourceKey, targetKey);
  }
  return mapping;
}

async function ensureGoldenStoreDb(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  storeWorkspaceKey: string,
  dryRun: boolean
): Promise<{ storeWritten: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  if (bundle.storeSnapshot) {
    return { storeWritten: false, warnings };
  }

  const extensionRoot = context.extensionUri?.fsPath;
  if (!extensionRoot) {
    warnings.push(
      "Extension path unavailable; cannot synthesize store.db for activation."
    );
    return { storeWritten: false, warnings };
  }
  const templatePath = path.join(
    extensionRoot,
    "resources",
    "golden-chat-store.template.db"
  );
  try {
    await fs.access(templatePath);
  } catch {
    warnings.push(
      "Golden store template missing from extension; cannot synthesize store.db for activation."
    );
    return { storeWritten: false, warnings };
  }

  const storeDbPath = path.join(
    resolveChatsRoot(),
    storeWorkspaceKey,
    bundle.conversationId,
    "store.db"
  );

  if (dryRun) {
    logChatRestoreDebug(
      `[dry-run] would hydrate golden store.db at ${storeDbPath} from bundle transcripts`
    );
    return { storeWritten: true, warnings };
  }

  const chat = chatManifestFromBundle(bundle);
  const hw = await hydrateGoldenStoreTemplate({
    templatePath,
    outputPath: storeDbPath,
    chat,
  });
  warnings.push(...hw.warnings);
  warnings.push(
    "Synthesized store.db from golden template (bundle had no store.db snapshot)."
  );
  logChatRestoreDebug(
    `golden store.db hydrated conversationId=${bundle.conversationId} path=${storeDbPath}`
  );
  return { storeWritten: true, warnings };
}

function applyProjectMappingToBundle(
  bundle: ChatBundle,
  projectMapping: Map<string, string>
): ChatBundle {
  if (projectMapping.size === 0) {
    return bundle;
  }
  const transcriptFiles = bundle.transcriptFiles.map((tf) => {
    const segments = tf.relativePath.split("/");
    if (segments.length === 0) {
      return tf;
    }
    const sourceKey = segments[0]!;
    const mappedKey = projectMapping.get(sourceKey) ?? sourceKey;
    return {
      ...tf,
      relativePath: [mappedKey, ...segments.slice(1)].join("/"),
    };
  });
  return { ...bundle, transcriptFiles };
}

export async function restoreChatBundle(
  context: vscode.ExtensionContext,
  bundle: ChatBundle,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options: RestoreChatBundleOptions = {}
): Promise<LoadChatResult> {
  if (
    bundle.type !== "chat-persistence" ||
    (bundle.schemaVersion !== 1 && bundle.schemaVersion !== 2)
  ) {
    throw new Error("Invalid or unsupported chat bundle format.");
  }

  const warnings: string[] = [];
  const verifyChecks: VerifyCheck[] = [];
  let conversationId = bundle.conversationId;
  let transcriptsWritten = 0;
  let storeWritten = false;
  let sidebarMerged = false;

  logChatRestoreDebug(
    `restoreChatBundle start conversationId=${conversationId} ${bundleArtifactsDebug(bundle)}`
  );

  progress.report({ message: "Resolving workspace..." });
  const folderFsPath =
    options.workspaceFolder?.trim() || (await pickImportWorkspaceFolder());
  if (!folderFsPath) {
    throw new Error(
      `Open a workspace folder in Cursor before importing a chat bundle (required for ${USER_LABEL_DOT_CURSOR}/chats/<md5(folder)> store.db path).`
    );
  }
  const wsCtx = await requireWorkspaceContext({ workspaceFolder: folderFsPath });
  const storeWorkspaceKey = wsCtx.chatsWorkspaceKey;
  const dryRun = options.dryRun === true;
  const syncGlobal = options.syncGlobal !== false;
  const pinRecent = options.pinRecent !== false;
  logChatRestoreDebug(
    `workspace context folder=${wsCtx.folderFsPath} chatsKey=${storeWorkspaceKey} storageId=${wsCtx.workspaceStorageId} dryRun=${dryRun} activate=${!!options.activate}`
  );

  const sourceProjectKeys = new Set<string>();
  for (const tf of bundle.transcriptFiles) {
    const segments = tf.relativePath.split("/");
    if (segments.length > 0) {
      sourceProjectKeys.add(segments[0]!);
    }
  }

  let projectMapping = await resolveImportProjectMapping(
    [...sourceProjectKeys].sort(),
    wsCtx.folderFsPath
  );
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  const autoMapImport =
    cfg.get<boolean>("chatImport.autoMapToOpenWorkspace") ?? true;
  const needsPrompt =
    sourceProjectKeys.size > 0 &&
    bundle.transcriptFiles.length > 0 &&
    (!autoMapImport ||
      [...sourceProjectKeys].some((k) => !projectMapping.has(k)));

  if (needsPrompt) {
    progress.report({ message: "Mapping projects..." });
    const mapping = await promptForTargetProject([...sourceProjectKeys].sort());
    if (mapping === null) {
      logChatRestoreDebug(`restoreChatBundle cancelled project mapping conversationId=${conversationId}`);
      return {
        conversationId,
        transcriptsWritten: 0,
        storeWritten: false,
        storeWorkspaceKey,
        sidebarMerged: false,
        warnings: ["Cancelled by user."],
      };
    }
    projectMapping = mapping;
  } else if (projectMapping.size > 0) {
    logChatRestoreDebug(
      `project mapping auto target=${[...new Set(projectMapping.values())].join(",")} sources=[${[...projectMapping.keys()].join(", ")}]`
    );
  }

  const targetProjectKey =
    projectMapping.size > 0
      ? [...new Set(projectMapping.values())][0]
      : folderToProjectKey(wsCtx.folderFsPath);

  const workspaceStateDb = path.join(
    resolveExtensionSyncRoots().cursorUser,
    "workspaceStorage",
    wsCtx.workspaceStorageId,
    "state.vscdb"
  );

  const extensionPath = context.extensionUri?.fsPath;

  try {
    await ensurePythonReady();
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : "Python 3 not available; set cursorSync.chatImport.pythonPath or install python3."
    );
  }

  const transportChatIo = await resolveTransportChatScript(
    "cursor_chat_io.py",
    extensionPath
  );
  if (!transportChatIo) {
    throw new Error(
      `transport-chat scripts not found in extension at ${extensionPath}. Reinstall Cursor Sync or set cursorSync.chatImport.transportChatScriptDir.`
    );
  }

  let workingBundle = bundle;
  const { bundle: diskKvEnriched, warnings: enrichWarnings } = await enrichBundleWithLiveDiskKv(
    workingBundle,
    { retries: 3, extensionPath }
  );
  workingBundle = diskKvEnriched;
  warnings.push(...enrichWarnings);

  const remappedBundle = applyProjectMappingToBundle(workingBundle, projectMapping);
  const tmpBundlePath = path.join(
    systemTmpDir(),
    `cursor-sync-import-${conversationId}-${Date.now()}.json`
  );
  try {
    await fs.writeFile(tmpBundlePath, JSON.stringify(remappedBundle, null, 2), "utf8");
    progress.report({ message: "Restoring chat files (transport-chat)..." });
    emitChatImportProgress({ conversationId, phase: "A", step: "python-disk-import-start" });
    const diskOutcome = await runPythonDiskImport({
      bundlePath: tmpBundlePath,
      workspaceFolder: wsCtx.folderFsPath,
      targetProject: targetProjectKey,
      stateDbPath: workspaceStateDb,
      dryRun,
      syncGlobal,
      pinRecent,
      extensionPath,
      log: (line) => logChatRestoreDebug(line),
    });
    emitChatImportProgress({ conversationId, phase: "A", step: "python-disk-import-done", ok: diskOutcome.ok });
    if (!diskOutcome.ok) {
      throw new Error(
        `Disk import failed (transport-chat): exit ${diskOutcome.exitCode}. ${diskOutcome.stderr.trim() || diskOutcome.stdout.trim()}`
      );
    }
    transcriptsWritten = remappedBundle.transcriptFiles.length;
    storeWritten = !!remappedBundle.storeSnapshot;
    const pyText = `${diskOutcome.stdout}\n${diskOutcome.stderr}`;
    const sidebarMergedMatch = pyText.match(/sidebar_merged=(true|false)/i);
    sidebarMerged = parseSidebarMergedFromPythonOutput(pyText);
    if (!storeWritten && !dryRun) {
      const golden = await ensureGoldenStoreDb(
        context,
        remappedBundle,
        storeWorkspaceKey,
        dryRun
      );
      storeWritten = golden.storeWritten;
      warnings.push(...golden.warnings);
    }
    logChatRestoreDebug(
      `disk restore via transport-chat conversationId=${conversationId} transcripts=${transcriptsWritten} store=${storeWritten}`
    );
  } finally {
    try {
      await fs.unlink(tmpBundlePath);
    } catch {
      /* ignore */
    }
  }

  if (workingBundle.storeSnapshot && !storeWritten) {
    throw new Error(
      "Bundle contained storeSnapshot but store.db was not written (required for import parity)."
    );
  }

  if (!dryRun) {
    progress.report({ message: "Verifying import..." });
    const diskChecks = await runDiskAndActivationVerify(conversationId, wsCtx, {
      bundle: workingBundle,
      postActivate: false,
    });
    verifyChecks.push(...diskChecks);
    for (const c of diskChecks) {
      logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
    }
    if (!verifyChecksAllOk(diskChecks)) {
      throw new Error(
        `Import verify failed (see verify lines above):\n${formatVerifyReport(diskChecks)}`
      );
    }

    const sidebarOnDisk = sidebarVisibleOnDiskFromVerify(diskChecks);
    const hadPythonSidebarFlag = sidebarMerged;
    if (
      !sidebarMerged &&
      sidebarOnDisk &&
      remappedBundle.sidebarSnapshot != null &&
      typeof remappedBundle.sidebarSnapshot === "object"
    ) {
      sidebarMerged = true;
    }

    if (sidebarMerged && remappedBundle.sidebarSnapshot) {
      await applyImmediateSidebarWriteback(remappedBundle, wsCtx);
      await queueSidebarWriteback(context, remappedBundle, wsCtx, {
        activate: options.activate === true,
      });
    }

    if (options.activate) {
      if (!storeWritten) {
        warnings.push(
          `Bundle has no store.db snapshot; IDE activation usually requires store.db at ${USER_LABEL_DOT_CURSOR}/chats/<md5(workspace)>/<conversationId>/store.db. Re-export from a machine where that file exists.`
        );
        logChatRestoreDebug(
          `activation warning conversationId=${conversationId} storeWritten=false (storeSnapshot absent or restore failed)`
        );
      }
      progress.report({ message: "Activating composer..." });
      emitChatImportProgress({ conversationId, phase: "B", step: "activation-start" });
      const activationOutcome = await runPostImportActivation(
        workingBundle,
        conversationId,
        wsCtx,
        {
          activateStrict: options.activateStrict,
          bridgeWaitResultMs: options.bridgeWaitResultMs,
          dryRun: false,
          extensionPath,
          skipPythonBridge: true,
          log: (line) => logChatRestoreDebug(line),
        }
      );
      emitChatImportProgress({
        conversationId,
        phase: "B",
        step: "activation-done",
        ok: activationOutcome.ok,
        detail: activationOutcome.stagedOnly ? "staged-only" : undefined,
      });
      if (
        options.activateStrict &&
        activationOutcome.stagedOnly &&
        !activationOutcome.ok
      ) {
        throw new Error(
          "Activation staged only (--activate-strict requires confirmed activation)"
        );
      }
      if (options.pingServer) {
        pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
      }
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
    } else if (options.postActivate) {
      progress.report({ message: "Verifying activation..." });
      const activationChecks = await verifyActivationChecks(conversationId);
      verifyChecks.push(...activationChecks);
      for (const c of activationChecks) {
        logChatRestoreDebug(`verify: ${formatVerifyCheckLine(c)}`);
      }
      if (!verifyChecksAllOk(activationChecks)) {
        throw new Error(
          `Activation verify failed:\n${formatVerifyReport(activationChecks)}`
        );
      }
    }
  } else {
    logChatRestoreDebug("[dry-run] skipped disk and activation verify");
    if (options.activate) {
      await runPostImportActivation(workingBundle, conversationId, wsCtx, {
        activateStrict: options.activateStrict,
        bridgeWaitResultMs: options.bridgeWaitResultMs,
        dryRun: true,
        extensionPath,
        skipPythonBridge: true,
        log: (line) => logChatRestoreDebug(line),
      });
    }
    if (options.pingServer) {
      pingServerProbe(conversationId, (line) => logChatRestoreDebug(line));
    }
  }

  if (!dryRun) {
    await pruneOldBackups(context);
  }

  const fidelity = summarizeBundleFidelity(workingBundle);
  for (const fw of fidelity.warnings) {
    if (!warnings.includes(fw)) {
      warnings.push(fw);
    }
  }
  publishImportFidelitySummary(conversationId, fidelity);

  const result: LoadChatResult = {
    conversationId,
    transcriptsWritten,
    storeWritten,
    storeWorkspaceKey,
    sidebarMerged,
    warnings,
    verifyChecks: verifyChecks.length > 0 ? verifyChecks : undefined,
    fidelity,
  };
  logChatRestoreDebug(
    `restoreChatBundle done conversationId=${conversationId} transcriptsWritten=${transcriptsWritten} storeWritten=${storeWritten} storeWorkspaceKey=${storeWorkspaceKey} sidebarMerged=${sidebarMerged} fidelity schemaVersion=${fidelity.schemaVersion} diskKvRows=${fidelity.diskKvRowCount} toolBubbles=${fidelity.toolBubbleCount} textOnlyLayer4=${fidelity.textOnlyLayer4} warnings=${warnings.length}${warnings.length > 0 ? ` [${warnings.join("; ")}]` : ""}`
  );
  void recordImportEntry(context, {
    conversationId,
    transcriptsWritten,
    storeWritten,
    sidebarMerged,
    warnings: warnings.length,
    timestamp: new Date().toISOString(),
    ...fidelityFieldsForImportHistory(fidelity),
  });
  return result;
}

export async function enrichImportResultWithBundleInspect(
  context: vscode.ExtensionContext,
  bundlePath: string,
  bundle: ChatBundle,
  result: LoadChatResult
): Promise<LoadChatResult> {
  const extensionPath = context.extensionPath;
  try {
    const inspectOutcome = await runPythonBundleInspect({
      bundlePath,
      extensionPath,
      log: (line) => logChatRestoreDebug(line),
    });
    if (inspectOutcome.ok) {
      const fromInspect = parsePythonInspectStdout(inspectOutcome.stdout);
      if (fromInspect) {
        const merged = mergeFidelitySummaries(
          result.fidelity ?? summarizeBundleFidelity(bundle),
          fromInspect
        );
        result.fidelity = merged;
        for (const fw of merged.warnings) {
          if (!result.warnings.includes(fw)) {
            result.warnings.push(fw);
          }
        }
        publishImportFidelitySummary(result.conversationId, merged);
      }
    }
  } catch (err) {
    logChatRestoreDebug(
      `bundle inspect skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return result;
}

export async function loadChat(
  context: vscode.ExtensionContext,
  bundlePath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  restoreOptions: RestoreChatBundleOptions
): Promise<LoadChatResult> {
  progress.report({ message: "Reading bundle..." });
  const raw = await fs.readFile(bundlePath, "utf-8");
  const parsed = parseChatBundleOrCollection(raw);
  if (parsed.kind === "collection" && parsed.collection.bundles.length > 1) {
    throw new Error(
      "This file contains multiple conversations. Use Cursor Sync: Import Chat Bundle to import them."
    );
  }
  const bundle =
    parsed.kind === "single" ? parsed.bundle : parsed.collection.bundles[0]!;
  const result = await restoreChatBundle(context, bundle, progress, restoreOptions);
  return enrichImportResultWithBundleInspect(context, bundlePath, bundle, result);
}

export function resolveProjectsRoot(): string {
  return path.join(resolveExtensionSyncRoots().dotCursor, "projects");
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function promptForTargetProject(sourceProjectKeys: string[]): Promise<Map<string, string> | null> {
  const projectsRoot = resolveProjectsRoot();
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    vscode.window.showErrorMessage(
      `Cannot read projects directory: ${projectsRoot}. Open a project in Cursor first.`
    );
    return null;
  }

  const localProjects = projectDirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (localProjects.length === 0) {
    vscode.window.showErrorMessage(
      "No local Cursor projects found. Open a project in Cursor first to create a project directory."
    );
    return null;
  }

  const { cursorUser } = resolveExtensionSyncRoots();
  const folderMap = await buildChatsKeyToFolderMap(cursorUser);

  const mapping = new Map<string, string>();

  for (const sourceKey of sourceProjectKeys) {
    const sourceLabel = humanWorkspaceLabel(sourceKey);
    const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
      label: projectQuickPickLabel(p.name, folderMap),
      description: p.name,
      detail: path.join(projectsRoot, p.name),
    }));
    picks.unshift({ label: "(Skip)", description: "skip" });

    const selected = await vscode.window.showQuickPick(picks, {
      title: `Map source project "${sourceLabel}" to a local project`,
      placeHolder: `Select the local project to receive chat transcripts from "${sourceLabel}"`,
    });

    if (!selected) {
      return null;
    }

    if (selected.description === "skip") {
      continue;
    }

    mapping.set(sourceKey, selected.description!);
  }

  return mapping;
}

export const __chatPersistenceTestUtils = {
  promptForTargetProject,
};
