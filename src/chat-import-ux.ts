import * as path from "node:path";
import { USER_LABEL_DOT_CURSOR, USER_LABEL_DOT_CURSOR_CHATS, USER_LABEL_DOT_CURSOR_PROJECTS, USER_LABEL_HOME_TILDE_PREFIX } from "./paths.js";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { refreshSidebar } from "./sidebar/index.js";
import {
  formatVerifyCheckLine,
  formatVerifyReport,
  type VerifyCheck,
} from "./chat-import-verify.js";
import {
  restoreOptionsFromConfiguration,
  type ChatBundle,
  type LoadChatResult,
  type RestoreChatBundleOptions,
} from "./chat-persistence.js";

export interface ChatImportPromptResult {
  workspaceFolder: string;
  restoreOptions: RestoreChatBundleOptions;
}

export interface BatchChatImportFailure {
  bundle: ChatBundle;
  error: string;
}

export interface BatchChatImportResult {
  successes: LoadChatResult[];
  failures: BatchChatImportFailure[];
}

function bundleTitleOrId(bundle: ChatBundle): string {
  const title = bundle.title?.trim();
  return title || bundle.conversationId;
}

function formatFailedImportLabels(
  failures: BatchChatImportFailure[],
  maxShown = 3
): string {
  const labels = failures.map((f) => bundleTitleOrId(f.bundle));
  if (labels.length <= maxShown) {
    return labels.join(", ");
  }
  const rest = labels.length - maxShown;
  return `${labels.slice(0, maxShown).join(", ")} and ${rest} more`;
}

export async function restoreChatBundlesBatch(
  context: vscode.ExtensionContext,
  bundles: ChatBundle[],
  restoreOptions: RestoreChatBundleOptions,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  logTag: "chat-load" | "gist-chat-import"
): Promise<BatchChatImportResult> {
  const logger = getLogger();
  const { restoreChatBundle } = await import("./chat-persistence.js");
  const successes: LoadChatResult[] = [];
  const failures: BatchChatImportFailure[] = [];
  const n = bundles.length;

  for (let i = 0; i < n; i++) {
    const bundle = bundles[i]!;
    const titleOrId = bundleTitleOrId(bundle);
    progress.report({ message: `Importing chat ${i + 1}/${n}: ${titleOrId}...` });
    try {
      const result = await restoreChatBundle(context, bundle, progress, restoreOptions);
      successes.push(result);
      logger.appendLine(
        `[${new Date().toISOString()}] [${logTag}] ok conversationId=${result.conversationId}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ bundle, error: msg });
      logger.appendLine(
        `[${new Date().toISOString()}] [${logTag}] fail conversationId=${bundle.conversationId}: ${msg}`
      );
    }
  }

  return { successes, failures };
}

export function shouldUseBatchImportOutcome(
  bundles: ChatBundle[],
  batch: BatchChatImportResult,
  pickerShown: boolean
): boolean {
  if (pickerShown) {
    return true;
  }
  if (bundles.length > 1) {
    return true;
  }
  if (batch.failures.length > 0) {
    return true;
  }
  if (batch.successes.length !== 1) {
    return true;
  }
  return false;
}

export async function pickImportWorkspaceFolder(): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  if (folders.length === 1) {
    return folders[0]!.uri.fsPath;
  }
  const picks: vscode.QuickPickItem[] = folders.map((f) => ({
    label: path.basename(f.uri.fsPath),
    description: f.uri.fsPath,
  }));
  const selected = await vscode.window.showQuickPick(picks, {
    title: "Select workspace folder for chat import",
    placeHolder: `store.db is written under ${USER_LABEL_DOT_CURSOR}/chats/<md5(this folder)>/`,
    ignoreFocusOut: true,
  });
  return selected?.description ?? null;
}

async function promptActivateChoice(
  defaultActivate: boolean
): Promise<boolean | null> {
  type ActivatePick = vscode.QuickPickItem & { activate: boolean };
  const items: ActivatePick[] = [
    {
      label: "Activate composer after import",
      description: "Runs composer.createComposer (import-v2)",
      activate: true,
    },
    {
      label: "Disk restore only",
      description: "Layers 1–3 only; no IDE activation",
      activate: false,
    },
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: "Chat import activation",
    placeHolder: defaultActivate
      ? "Default: activate (cursorSync.chatImport.activateDefault)"
      : "Default: disk only (cursorSync.chatImport.activateDefault)",
    ignoreFocusOut: true,
  });
  if (!selected) {
    return null;
  }
  return selected.activate;
}

export async function promptChatImportOptions(options?: {
  forceActivate?: boolean;
  skipActivatePrompt?: boolean;
}): Promise<ChatImportPromptResult | null> {
  const folderFsPath = await pickImportWorkspaceFolder();
  if (!folderFsPath) {
    vscode.window.showErrorMessage(
      "Open a workspace folder in Cursor before importing a chat bundle."
    );
    return null;
  }

  const restoreOptions: RestoreChatBundleOptions = {
    ...restoreOptionsFromConfiguration(),
    workspaceFolder: folderFsPath,
  };

  if (options?.forceActivate) {
    restoreOptions.activate = true;
    return { workspaceFolder: folderFsPath, restoreOptions };
  }

  if (options?.skipActivatePrompt) {
    return { workspaceFolder: folderFsPath, restoreOptions };
  }

  const activateChoice = await promptActivateChoice(restoreOptions.activate === true);
  if (activateChoice === null) {
    return null;
  }
  restoreOptions.activate = activateChoice;
  return { workspaceFolder: folderFsPath, restoreOptions };
}

export function formatVerifySummary(checks: VerifyCheck[] | undefined): string {
  if (!checks || checks.length === 0) {
    return "";
  }
  const ok = checks.filter((c) => c.status === "OK").length;
  const warn = checks.filter((c) => c.status === "WARN").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;
  const pending = checks.filter((c) => c.status === "PENDING").length;
  const skip = checks.filter((c) => c.status === "SKIP").length;
  const parts: string[] = [`verify ${checks.length} checks`];
  if (ok > 0) {
    parts.push(`${ok} OK`);
  }
  if (warn > 0) {
    parts.push(`${warn} WARN`);
  }
  if (fail > 0) {
    parts.push(`${fail} FAIL`);
  }
  if (pending > 0) {
    parts.push(`${pending} PENDING`);
  }
  if (skip > 0) {
    parts.push(`${skip} SKIP`);
  }
  return parts.join(", ");
}

export function buildChatImportResultMessage(
  result: LoadChatResult,
  restoreOptions: RestoreChatBundleOptions
): string {
  const parts: string[] = [`Chat "${result.conversationId}" loaded.`];
  if (result.transcriptsWritten > 0) {
    parts.push(
      `${result.transcriptsWritten} transcript file${result.transcriptsWritten === 1 ? "" : "s"}`
    );
  }
  if (result.storeWritten) {
    parts.push("store.db restored");
  }
  if (result.sidebarMerged) {
    parts.push("sidebar merged");
  }
  if (restoreOptions.activate) {
    parts.push("activation requested");
  }
  const verifySummary = formatVerifySummary(result.verifyChecks);
  if (verifySummary) {
    parts.push(verifySummary);
  }
  if (result.fidelity) {
    parts.push(
      `schema v${result.fidelity.schemaVersion}, ${result.fidelity.toolBubbleCount} tool bubbles`
    );
    if (result.fidelity.textOnlyLayer4) {
      parts.push("text-only Layer 4");
    }
  }
  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
  }
  return parts.join(" | ");
}

export async function presentChatImportOutcome(
  context: vscode.ExtensionContext,
  result: LoadChatResult,
  restoreOptions: RestoreChatBundleOptions,
  logTag: "chat-load" | "gist-chat-import"
): Promise<void> {
  const logger = getLogger();
  const message = buildChatImportResultMessage(result, restoreOptions);
  if (result.fidelity?.textOnlyLayer4) {
    vscode.window.showWarningMessage(
      `${message} — Text-only Layer 4: no diskKvSnapshot (schema v${result.fidelity.schemaVersion}). Tool/MCP UI cards will not match the source; re-export with Python transport after opening the chat on the source machine.`
    );
  } else {
    vscode.window.showInformationMessage(message);
  }

  if (result.verifyChecks && result.verifyChecks.length > 0) {
    const report = formatVerifyReport(result.verifyChecks);
    for (const line of report.split("\n")) {
      logger.appendLine(`[${new Date().toISOString()}] [${logTag}] verify: ${line}`);
    }
    for (const check of result.verifyChecks) {
      logger.appendLine(
        `[${new Date().toISOString()}] [chat-restore-debug] verify: ${formatVerifyCheckLine(check)}`
      );
    }
  }

  for (const w of result.warnings) {
    logger.appendLine(`[${new Date().toISOString()}] [${logTag}] ${w}`);
  }

  refreshSidebar();
}

export async function presentBatchChatImportOutcome(
  context: vscode.ExtensionContext,
  batch: BatchChatImportResult,
  restoreOptions: RestoreChatBundleOptions,
  logTag: "chat-load" | "gist-chat-import",
  totalAttempted: number
): Promise<void> {
  const logger = getLogger();

  for (const result of batch.successes) {
    if (result.verifyChecks && result.verifyChecks.length > 0) {
      const report = formatVerifyReport(result.verifyChecks);
      for (const line of report.split("\n")) {
        logger.appendLine(
          `[${new Date().toISOString()}] [${logTag}] verify (${result.conversationId}): ${line}`
        );
      }
      for (const check of result.verifyChecks) {
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] verify (${result.conversationId}): ${formatVerifyCheckLine(check)}`
        );
      }
    }
    for (const w of result.warnings) {
      logger.appendLine(
        `[${new Date().toISOString()}] [${logTag}] (${result.conversationId}) ${w}`
      );
    }
  }

  for (const failure of batch.failures) {
    logger.appendLine(
      `[${new Date().toISOString()}] [${logTag}] FAILED ${failure.bundle.conversationId}: ${failure.error}`
    );
  }

  const successCount = batch.successes.length;
  const chatWord = totalAttempted === 1 ? "chat" : "chats";
  const partialFail = batch.failures.length > 0;
  const anyTextOnlyLayer4 = batch.successes.some((r) => r.fidelity?.textOnlyLayer4);

  if (successCount === 0) {
    const detail = formatFailedImportLabels(batch.failures);
    vscode.window.showErrorMessage(
      `Chat import failed: 0/${totalAttempted} imported.${detail ? ` ${detail}` : ""}`
    );
    return;
  }

  let summary = `Imported ${successCount}/${totalAttempted} ${chatWord}.`;
  if (partialFail) {
    summary += ` ${batch.failures.length} failed: ${formatFailedImportLabels(batch.failures)}.`;
  }
  if (anyTextOnlyLayer4) {
    summary +=
      " Text-only Layer 4: no diskKvSnapshot on some imports; tool/MCP UI cards may not match the source.";
  }

  if (partialFail || anyTextOnlyLayer4) {
    vscode.window.showWarningMessage(summary);
  } else {
    vscode.window.showInformationMessage(summary);
  }

  if (batch.successes.length > 0) {
    refreshSidebar();
  }
}

export async function presentChatImportOutcomeForBatch(
  context: vscode.ExtensionContext,
  bundles: ChatBundle[],
  batch: BatchChatImportResult,
  restoreOptions: RestoreChatBundleOptions,
  logTag: "chat-load" | "gist-chat-import",
  pickerShown: boolean
): Promise<void> {
  if (!shouldUseBatchImportOutcome(bundles, batch, pickerShown) && batch.successes.length === 1) {
    await presentChatImportOutcome(context, batch.successes[0]!, restoreOptions, logTag);
    return;
  }
  await presentBatchChatImportOutcome(
    context,
    batch,
    restoreOptions,
    logTag,
    bundles.length
  );
}
