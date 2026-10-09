import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  __infoMessageCalls,
  __resetVscodeCommandsMock,
  __setClipboardWriteTextImpl,
  __setExecuteCommandImpl,
  __setRegisteredCommands,
  __setShowErrorMessageResult,
} from "./__mocks__/vscode.js";
import { CREATE_COMPOSER_COMMAND_ID } from "../src/chat-import-activate.js";
import {
  buildSyncDebugPrompt,
  DEBUG_WITH_CURSOR_ACTION,
  openComposerWithPrefilledPrompt,
  readExtensionVersion,
  sanitizeSyncDebugMessage,
  showSyncFailureWithDebug,
  type SyncDebugFailure,
} from "../src/sync-debug.js";
import type * as vscode from "vscode";

function baseFailure(overrides: Partial<SyncDebugFailure> = {}): SyncDebugFailure {
  return {
    operation: "push",
    trigger: "manual",
    message: "GitHub API returned 401 Unauthorized",
    category: "AUTH_FAILED",
    extensionVersion: "0.8.0",
    platform: "linux",
    ...overrides,
  };
}

describe("sync-debug", () => {
  beforeEach(() => {
    __resetVscodeCommandsMock();
  });

  it("exports DEBUG_WITH_CURSOR_ACTION label", () => {
    expect(DEBUG_WITH_CURSOR_ACTION).toBe("Debug with Cursor");
  });

  describe("readExtensionVersion", () => {
    it("matches package.json version", () => {
      const packageJson = JSON.parse(
        readFileSync(join(process.cwd(), "package.json"), "utf8")
      ) as { version: string };

      expect(readExtensionVersion()).toBe(packageJson.version);
    });
  });

  describe("sanitizeSyncDebugMessage", () => {
    it("redacts GitHub token prefixes and paths with exact placeholders", () => {
      const sanitized = sanitizeSyncDebugMessage(
        "token ghp_abc gho_def github_pat_ghi gist abcdef1234567890abcdef1234567890 paths /home/u/x ~/.cursor/x C:/Users/u/x /root/x /etc/passwd"
      );

      expect(sanitized).toContain("[REDACTED_TOKEN]");
      expect(sanitized).toContain("[REDACTED_GIST_ID]");
      expect(sanitized).toContain("[REDACTED_PATH]");
      expect(sanitized).not.toContain("ghp_abc");
      expect(sanitized).not.toContain("gho_def");
      expect(sanitized).not.toContain("github_pat_ghi");
      expect(sanitized).not.toContain("abcdef1234567890abcdef1234567890");
      expect(sanitized).not.toContain("/home/u/x");
      expect(sanitized).not.toContain("~/.cursor/x");
      expect(sanitized).not.toContain("C:/Users/u/x");
      expect(sanitized).not.toContain("/root/x");
      expect(sanitized).not.toContain("/etc/passwd");
    });
  });

  describe("buildSyncDebugPrompt", () => {
    it("includes exact operation and trigger lines plus fix instructions", () => {
      const prompt = buildSyncDebugPrompt(
        baseFailure({
          operation: "pull",
          direction: "pull",
          trigger: "manual",
          category: "NETWORK_ERROR",
          message: "Network request failed",
          platform: "darwin",
          extensionVersion: "1.2.3",
        })
      );

      expect(prompt).toContain("- operation: pull");
      expect(prompt).toContain("- trigger: manual");
      expect(prompt).toContain("- category: NETWORK_ERROR");
      expect(prompt).toContain("- message: Network request failed");
      expect(prompt).toContain("- platform: darwin");
      expect(prompt).toContain("- extensionVersion: 1.2.3");
      expect(prompt).toContain("src/push.ts");
      expect(prompt).toContain("src/pull.ts");
      expect(prompt).toContain("src/scheduler.ts");
      expect(prompt).toContain("src/extension.ts");
      expect(prompt).toContain("src/diagnostics.ts");
      expect(prompt).toContain("src/gist.ts");
      expect(prompt).toMatch(/permanent.*fix|exact user action/i);
      expect(prompt).toMatch(/output channel|sync history/i);
    });

    it("redacts secrets with exact placeholders in the message line", () => {
      const secretMessage =
        "Failed for ghp_abcdefghijklmnopqrstuvwxyz1234567890 gist abcdef1234567890abcdef1234567890 at /home/marcelo/.cursor/sync.json";

      const prompt = buildSyncDebugPrompt(
        baseFailure({
          message: secretMessage,
        })
      );

      expect(prompt).toContain("[REDACTED_TOKEN]");
      expect(prompt).toContain("[REDACTED_GIST_ID]");
      expect(prompt).toContain("[REDACTED_PATH]");
      expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(prompt).not.toContain("abcdef1234567890abcdef1234567890");
      expect(prompt).not.toContain("/home/marcelo/.cursor/sync.json");
    });

    it("uses different wording for scheduled vs manual triggers", () => {
      const manualPrompt = buildSyncDebugPrompt(
        baseFailure({ trigger: "manual", operation: "syncNow" })
      );
      const scheduledPrompt = buildSyncDebugPrompt(
        baseFailure({ trigger: "scheduled", operation: "scheduler" })
      );

      expect(manualPrompt).toContain("- trigger: manual");
      expect(manualPrompt).toContain("manual sync initiated by the user");
      expect(scheduledPrompt).toContain("- trigger: scheduled");
      expect(scheduledPrompt).toContain("scheduled background sync");
      expect(manualPrompt).not.toContain("scheduled background sync");
      expect(scheduledPrompt).not.toContain("manual sync initiated by the user");
    });

    it("includes direction, statusCode, and conflictCount when set", () => {
      const prompt = buildSyncDebugPrompt(
        baseFailure({
          operation: "push",
          direction: "push",
          statusCode: 409,
          conflictCount: 3,
        })
      );

      expect(prompt).toContain("- direction: push");
      expect(prompt).toContain("- statusCode: 409");
      expect(prompt).toContain("- conflictCount: 3");
    });

    it("omits direction when not set", () => {
      const prompt = buildSyncDebugPrompt(
        baseFailure({
          operation: "syncNow",
          direction: undefined,
        })
      );

      expect(prompt).not.toContain("- direction:");
    });
  });

  describe("showSyncFailureWithDebug", () => {
    const mockContext = {} as unknown as vscode.ExtensionContext;

    it("calls createComposer when Debug with Cursor is selected", async () => {
      __setRegisteredCommands([
        CREATE_COMPOSER_COMMAND_ID,
        "composer.openComposer",
      ]);
      __setShowErrorMessageResult(DEBUG_WITH_CURSOR_ACTION);

      const executed: Array<{ command: string; args: unknown[] }> = [];
      __setExecuteCommandImpl(async (command, ...args) => {
        executed.push({ command, args });
        if (command === CREATE_COMPOSER_COMMAND_ID) {
          const partialState = args[0] as { composerId?: string };
          return { composerId: partialState.composerId };
        }
        return undefined;
      });

      await showSyncFailureWithDebug(mockContext, baseFailure());

      const createCall = executed.find(
        (entry) => entry.command === CREATE_COMPOSER_COMMAND_ID
      );
      expect(createCall).toBeDefined();
      expect(createCall?.args[0]).toMatchObject({
        text: expect.stringContaining("Cursor Sync failed"),
      });
      expect(createCall?.args[1]).toEqual({ openInNewTab: true, view: "editor" });
    });

    it("does nothing when the notification is dismissed", async () => {
      __setRegisteredCommands([CREATE_COMPOSER_COMMAND_ID]);
      __setShowErrorMessageResult(undefined);

      const executed: string[] = [];
      __setExecuteCommandImpl(async (command) => {
        executed.push(command);
        return undefined;
      });

      await showSyncFailureWithDebug(mockContext, baseFailure());

      expect(executed).toEqual([]);
    });
  });

  describe("openComposerWithPrefilledPrompt", () => {
    it("copies to clipboard and shows info when createComposer is missing", async () => {
      __setRegisteredCommands([]);

      const clipboardTexts: string[] = [];
      __setClipboardWriteTextImpl(async (text) => {
        clipboardTexts.push(text);
      });

      await openComposerWithPrefilledPrompt("debug prompt text");

      expect(clipboardTexts).toEqual(["debug prompt text"]);
      expect(__infoMessageCalls.some((msg) => msg.includes("clipboard"))).toBe(
        true
      );
    });
  });
});
