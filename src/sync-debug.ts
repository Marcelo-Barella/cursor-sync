import { randomUUID } from "node:crypto";
import { nodePlatform } from "./os-runtime.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  COMPOSER_GET_HANDLE_COMMAND_ID,
  CREATE_COMPOSER_COMMAND_ID,
  FOCUS_COMPOSER_COMMAND_ID,
  OPEN_COMPOSER_COMMAND_ID,
  composerCommandAvailable,
  parseComposerIdFromCommandResult,
} from "./chat-import-activate.js";
import { getLogger } from "./diagnostics.js";

export type SyncDebugOperation = "syncNow" | "push" | "pull" | "scheduler";
export type SyncDebugDirection = "push" | "pull";
export type SyncDebugTrigger = "manual" | "scheduled" | "syncNow" | "startup";

export type SyncDebugFailure = {
  operation: SyncDebugOperation;
  direction?: SyncDebugDirection;
  trigger: SyncDebugTrigger;
  message: string;
  category?: string;
  statusCode?: number;
  conflictCount?: number;
  extensionVersion: string;
  platform: string;
};

export const DEBUG_WITH_CURSOR_ACTION = "Debug with Cursor";

const CLIPBOARD_FALLBACK_MESSAGE =
  "The debug prompt was copied to your clipboard. Paste it into Cursor chat to continue debugging.";

const DEFAULT_CREATE_COMPOSER_OPTIONS = { openInNewTab: true, view: "editor" };

const GITHUB_TOKEN_PATTERN = /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g;
const GIST_ID_PATTERN = /\b[a-f0-9]{32}\b/gi;
const TILDE_PATH_PATTERN = /~(?:\/|\\)[^\s"'`,;:]+/g;
const ABSOLUTE_PATH_PATTERN =
  /(?:\/(?:home|Users|root|etc|tmp|var|opt|private|Volumes)(?:\/[^\s"'`,;:]+)*|(?:[A-Za-z]:[\\/][^\s"'`,;:]+)+)/g;

let cachedExtensionVersion: string | undefined;

export function readExtensionVersion(): string {
  if (cachedExtensionVersion !== undefined) {
    return cachedExtensionVersion;
  }
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8")
    ) as { version: string };
    cachedExtensionVersion = packageJson.version;
  } catch {
    cachedExtensionVersion = "unknown";
  }
  return cachedExtensionVersion;
}

export function buildSyncDebugFailure(
  operation: SyncDebugOperation,
  trigger: SyncDebugTrigger,
  message: string,
  extra?: Partial<
    Pick<SyncDebugFailure, "direction" | "category" | "statusCode" | "conflictCount">
  >
): SyncDebugFailure {
  return {
    operation,
    trigger,
    message,
    extensionVersion: readExtensionVersion(),
    platform: nodePlatform(),
    ...extra,
  };
}

export function sanitizeSyncDebugMessage(message: string): string {
  return message
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(GIST_ID_PATTERN, "[REDACTED_GIST_ID]")
    .replace(TILDE_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function triggerDescription(trigger: SyncDebugTrigger): string {
  if (trigger === "scheduled") {
    return "This failure occurred during a scheduled background sync.";
  }
  if (trigger === "syncNow") {
    return "This failure occurred during Sync Now.";
  }
  if (trigger === "startup") {
    return "This failure occurred during startup sync.";
  }
  return "This failure occurred during a manual sync initiated by the user.";
}

export function buildSyncDebugPrompt(failure: SyncDebugFailure): string {
  const sanitizedMessage = sanitizeSyncDebugMessage(failure.message);
  const lines = [
    "Cursor Sync failed. Please diagnose why this sync operation failed and help resolve it.",
    "",
    "## Failure context",
    `- operation: ${failure.operation}`,
    `- trigger: ${failure.trigger}`,
    triggerDescription(failure.trigger),
  ];

  if (failure.direction) {
    lines.push(`- direction: ${failure.direction}`);
  }
  if (failure.category) {
    lines.push(`- category: ${sanitizeSyncDebugMessage(failure.category)}`);
  }
  if (failure.statusCode !== undefined) {
    lines.push(`- statusCode: ${failure.statusCode}`);
  }
  if (failure.conflictCount !== undefined) {
    lines.push(`- conflictCount: ${failure.conflictCount}`);
  }

  lines.push(
    `- message: ${sanitizedMessage}`,
    `- platform: ${failure.platform}`,
    `- extensionVersion: ${failure.extensionVersion}`,
    "",
    "## What to inspect",
    "Review the Cursor Sync implementation and local state, including:",
    "- src/push.ts",
    "- src/pull.ts",
    "- src/scheduler.ts",
    "- src/extension.ts",
    "- src/diagnostics.ts",
    "- src/gist.ts",
    "- Cursor Sync output channel",
    "- sync history JSON in extension global storage",
    "",
    "## Expected outcome",
    "Prefer a permanent code or configuration fix when appropriate.",
    "If no code fix applies, explain the exact user action required.",
    "Do not include or request secrets such as GitHub tokens, raw Gist IDs, or private file paths unless the user explicitly provides them."
  );

  return lines.join("\n");
}

function logSyncDebug(message: string): void {
  try {
    getLogger().appendLine(message);
  } catch {
    // swallow
  }
}

async function tryOpenComposer(
  composerId: string,
  view: string = "editor"
): Promise<boolean> {
  const openOpts = { openInNewTab: true, view };

  if (await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID)) {
    try {
      await vscode.commands.executeCommand(
        OPEN_COMPOSER_COMMAND_ID,
        composerId,
        openOpts
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSyncDebug(`composer.openComposer failed: ${message}`);
      try {
        await vscode.commands.executeCommand(
          OPEN_COMPOSER_COMMAND_ID,
          composerId
        );
        return true;
      } catch (err2) {
        const message2 = err2 instanceof Error ? err2.message : String(err2);
        logSyncDebug(`composer.openComposer (id only) failed: ${message2}`);
      }
    }
  }

  if (await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID)) {
    try {
      await vscode.commands.executeCommand(
        FOCUS_COMPOSER_COMMAND_ID,
        composerId
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSyncDebug(`composer.focusComposer failed: ${message}`);
    }
  }

  return false;
}

async function clipboardFallback(prompt: string): Promise<void> {
  try {
    await vscode.env.clipboard.writeText(prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSyncDebug(`clipboard.writeText failed: ${message}`);
  }
  try {
    await vscode.window.showInformationMessage(CLIPBOARD_FALLBACK_MESSAGE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSyncDebug(`showInformationMessage failed: ${message}`);
  }
}

async function tryOpenEmptyComposer(): Promise<void> {
  if (!(await composerCommandAvailable(CREATE_COMPOSER_COMMAND_ID))) {
    return;
  }
  try {
    const composerId = randomUUID();
    const result = await vscode.commands.executeCommand(
      CREATE_COMPOSER_COMMAND_ID,
      { composerId },
      DEFAULT_CREATE_COMPOSER_OPTIONS
    );
    const resolvedId = parseComposerIdFromCommandResult(result, composerId);
    await tryOpenComposer(resolvedId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSyncDebug(`empty composer.createComposer failed: ${message}`);
  }
}

async function anyComposerCommandAvailable(): Promise<boolean> {
  if (await composerCommandAvailable(CREATE_COMPOSER_COMMAND_ID)) {
    return true;
  }
  if (await composerCommandAvailable(OPEN_COMPOSER_COMMAND_ID)) {
    return true;
  }
  if (await composerCommandAvailable(FOCUS_COMPOSER_COMMAND_ID)) {
    return true;
  }
  if (await composerCommandAvailable(COMPOSER_GET_HANDLE_COMMAND_ID)) {
    return true;
  }
  return false;
}

export async function openComposerWithPrefilledPrompt(prompt: string): Promise<void> {
  try {
    if (await composerCommandAvailable(CREATE_COMPOSER_COMMAND_ID)) {
      try {
        const composerId = randomUUID();
        const partialState = { composerId, text: prompt };
        const result = await vscode.commands.executeCommand(
          CREATE_COMPOSER_COMMAND_ID,
          partialState,
          DEFAULT_CREATE_COMPOSER_OPTIONS
        );
        const resolvedId = parseComposerIdFromCommandResult(result, composerId);
        if (await tryOpenComposer(resolvedId)) {
          return;
        }
        logSyncDebug(
          "Composer prefill created but open/focus failed; falling back to clipboard"
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logSyncDebug(`composer.createComposer failed: ${message}`);
      }

      await clipboardFallback(prompt);
      await tryOpenEmptyComposer();
      return;
    }

    await clipboardFallback(prompt);
    if (await anyComposerCommandAvailable()) {
      await tryOpenEmptyComposer();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSyncDebug(`openComposerWithPrefilledPrompt failed: ${message}`);
  }
}

export async function showSyncFailureWithDebug(
  _context: vscode.ExtensionContext,
  failure: SyncDebugFailure,
  options?: { level?: "error" | "warning"; title?: string }
): Promise<void> {
  const prompt = buildSyncDebugPrompt(failure);
  const message = options?.title ?? failure.message;
  const level = options?.level ?? "error";
  const showMessage =
    level === "warning"
      ? vscode.window.showWarningMessage.bind(vscode.window)
      : vscode.window.showErrorMessage.bind(vscode.window);

  const selection = await showMessage(message, DEBUG_WITH_CURSOR_ACTION);
  if (selection === DEBUG_WITH_CURSOR_ACTION) {
    await openComposerWithPrefilledPrompt(prompt);
  }
}
