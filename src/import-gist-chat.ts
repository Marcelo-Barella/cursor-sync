import * as vscode from "vscode";
import { GistClient, fetchGistFileContent } from "./gist.js";
import type { GistFile } from "./types.js";
import { getLogger } from "./diagnostics.js";
import { getToken } from "./auth.js";
import type { ChatBundle } from "./chat-persistence.js";
import {
  presentChatImportOutcomeForBatch,
  promptChatImportOptions,
  restoreChatBundlesBatch,
} from "./chat-import-ux.js";
import { TRANSCRIPT_MANIFEST_FILE_NAME } from "./transcript-bundle.js";
import {
  CHAT_BUNDLE_GIST_FILE_NAME,
  CHAT_BUNDLES_GIST_FILE_NAME,
  parseChatBundleOrCollection,
  resolveBundlesFromParsedExport,
} from "./chat-bundle-format.js";
import { isEncryptedChatGistPayload } from "./chat-gist-crypto.js";
import {
  decryptChatPayloadFromGist,
  reexportLegacyChatUnderDek,
} from "./e2e/chat-payload-crypto.js";
import {
  assertCanReadE2eGist,
  GIST_LOCKED_MESSAGE,
  readLogicalFileFromGistMap,
} from "./e2e/gist-read.js";
import { tryReadGistE2eMarker } from "./e2e/gist-bundle.js";
import { isE2eDekUnlocked, requireE2eUnlocked } from "./e2e/gate.js";
import { requireChatEncryptionPassword } from "./chat-encryption-auth.js";
export { CHAT_BUNDLE_GIST_FILE_NAME, CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";

export async function executeImportChatFromGist(
  context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();

  const gistInput = await vscode.window.showInputBox({
    prompt: "Enter Gist URL or ID",
    placeHolder: "https://gist.github.com/user/abc123 or just abc123",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const id = extractGistId(value);
      return id ? null : "Invalid Gist URL or ID";
    },
  });

  if (!gistInput) {
    return;
  }

  const gistId = extractGistId(gistInput);
  if (!gistId) {
    vscode.window.showErrorMessage("Could not extract a valid Gist ID from input.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Importing chat from Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        logger.appendLine(
          `[${new Date().toISOString()}] [chat-restore-debug] gist import start gistId=${gistId}`
        );
        progress.report({ message: "Fetching Gist..." });
        const { bundles, pickerShown } = await fetchAndResolveGistBundles(
          context,
          gistId,
          progress
        );
        const promptResult = await promptChatImportOptions();
        if (!promptResult) {
          return;
        }
        const batch = await restoreChatBundlesBatch(
          context,
          bundles,
          promptResult.restoreOptions,
          progress,
          "gist-chat-import"
        );
        for (const result of batch.successes) {
          logger.appendLine(
            `[${new Date().toISOString()}] [chat-restore-debug] gist import done gistId=${gistId} conversationId=${result.conversationId} transcriptsWritten=${result.transcriptsWritten} storeWritten=${result.storeWritten} sidebarMerged=${result.sidebarMerged} warnings=${result.warnings.length}`
          );
        }
        await presentChatImportOutcomeForBatch(
          context,
          bundles,
          batch,
          promptResult.restoreOptions,
          "gist-chat-import",
          pickerShown
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.appendLine(`[${new Date().toISOString()}] [gist-chat-import] FAILED: ${msg}`);
        vscode.window.showErrorMessage(`Gist chat import failed: ${msg}`);
      }
    }
  );
}

async function resolveGistChatFileContent(
  context: vscode.ExtensionContext,
  gistId: string,
  raw: string,
  logicalFileName: string,
  gistFiles?: Record<string, { content?: string }>
): Promise<string> {
  const decrypted = await decryptChatPayloadFromGist(context, raw, logicalFileName, {
    gistFiles,
    promptLegacyPassword: async () => {
      if (!isEncryptedChatGistPayload(raw)) {
        return undefined;
      }
      return requireChatEncryptionPassword(context, "import-envelope");
    },
  });
  if (isEncryptedChatGistPayload(raw)) {
    try {
      await reexportLegacyChatUnderDek(context, gistId, decrypted, logicalFileName);
    } catch {
    }
  }
  return decrypted;
}

async function resolveChatBundlesFromGistContent(
  context: vscode.ExtensionContext,
  gistId: string,
  raw: string,
  fileLabel: string,
  requireCollection: boolean,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  gistFiles?: Record<string, { content?: string }>,
  logicalFileName?: string
): Promise<{ bundles: ChatBundle[]; pickerShown: boolean }> {
  const plaintext = await resolveGistChatFileContent(
    context,
    gistId,
    raw,
    logicalFileName ?? fileLabel,
    gistFiles
  );
  const parsed = parseChatBundleOrCollection(plaintext);
  if (requireCollection && parsed.kind !== "collection") {
    throw new Error("Invalid chat-bundles.json: expected chat-bundles-collection.");
  }
  const pickerShown =
    parsed.kind === "collection" && parsed.collection.bundles.length > 1;
  if (pickerShown) {
    progress.report({ message: "Select conversations to import..." });
  }
  const bundles = await resolveBundlesFromParsedExport(parsed);
  if (!bundles) {
    throw new Error("Chat import cancelled.");
  }
  return { bundles, pickerShown };
}

async function fetchAndResolveGistBundles(
  context: vscode.ExtensionContext,
  gistId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<{ bundles: ChatBundle[]; pickerShown: boolean }> {
  const logger = getLogger();
  const token = await getToken(context);
  if (!token) {
    throw new Error(
      "GitHub token not configured. Use 'Cursor Sync: Configure GitHub' to set your token."
    );
  }

  const gist = await fetchGist(gistId, token);
  if (!gist) {
    throw new Error(`Could not fetch Gist "${gistId}". Check the ID and your GitHub token.`);
  }

  if (gist.files && tryReadGistE2eMarker(gist.files)) {
    const access = await assertCanReadE2eGist(context, gist.files);
    if (!access.ok) {
      throw new Error(access.message === GIST_LOCKED_MESSAGE ? GIST_LOCKED_MESSAGE : access.message);
    }
  }

  progress.report({ message: "Reading chat bundle..." });
  const bundleFile = gist.files?.[CHAT_BUNDLE_GIST_FILE_NAME] as GistFile | undefined;
  const collectionFile = gist.files?.[CHAT_BUNDLES_GIST_FILE_NAME] as GistFile | undefined;

  let resolved: { bundles: ChatBundle[]; pickerShown: boolean };

  const bundleRaw = await readEncryptedOrPlainGistFile(
    context,
    gist.files ?? {},
    token,
    CHAT_BUNDLE_GIST_FILE_NAME,
    bundleFile
  );
  const collectionRaw = await readEncryptedOrPlainGistFile(
    context,
    gist.files ?? {},
    token,
    CHAT_BUNDLES_GIST_FILE_NAME,
    collectionFile
  );

  if (bundleRaw && collectionRaw) {
    throw new Error(
      "Gist contains both chat-bundle.json and chat-bundles.json. Remove one file so import knows which export to use."
    );
  }

  if (bundleRaw) {
    resolved = await resolveChatBundlesFromGistContent(
      context,
      gistId,
      bundleRaw,
      "chat-bundle.json",
      false,
      progress,
      gist.files,
      CHAT_BUNDLE_GIST_FILE_NAME
    );
  } else if (collectionRaw) {
    resolved = await resolveChatBundlesFromGistContent(
      context,
      gistId,
      collectionRaw,
      "chat-bundles.json",
      true,
      progress,
      gist.files,
      CHAT_BUNDLES_GIST_FILE_NAME
    );
  } else {
    if (gist.files?.[TRANSCRIPT_MANIFEST_FILE_NAME]) {
      throw new Error(
        "Gist does not contain a chat bundle (chat-bundle.json). This Gist is an agent transcript export. Use Cursor Sync: Import Agent Transcripts from Private Gist."
      );
    }
    if (gist.files?.["manifest.json"]) {
      throw new Error(
        "Gist does not contain a chat bundle (chat-bundle.json). This Gist is a settings backup. Use Cursor Sync: Import from Private Gist."
      );
    }
    throw new Error(
      "Gist does not contain chat-bundle.json. Export a chat with Cursor Sync: Export Chat to Private Gist first."
    );
  }

  const { bundles, pickerShown } = resolved;

  progress.report({ message: "Validating chat bundle..." });
  if (bundles.length === 1) {
    const bundle = bundles[0]!;
    const tfCount = bundle.transcriptFiles?.length ?? 0;
    const storeBytes = bundle.storeSnapshot?.sizeBytes ?? 0;
    const sidebarKeys = bundle.sidebarSnapshot
      ? Object.keys(bundle.sidebarSnapshot).join(",")
      : "none";
    logger.appendLine(
      `[${new Date().toISOString()}] [chat-restore-debug] gist import validated gistId=${gistId} conversationId=${bundle.conversationId} transcriptFiles=${tfCount} storeSnapshot=${bundle.storeSnapshot ? `${storeBytes}b` : "absent"} sidebarSnapshot=${sidebarKeys}`
    );
  } else {
    const ids = bundles.map((b) => b.conversationId).join(",");
    logger.appendLine(
      `[${new Date().toISOString()}] [chat-restore-debug] gist import validated gistId=${gistId} batchCount=${bundles.length} conversationIds=${ids}`
    );
  }
  return { bundles, pickerShown };
}

async function fetchGist(
  gistId: string,
  token: string | undefined
): Promise<{ files?: Record<string, { content?: string }> } | null> {
  const gistClient = token ? new GistClient(token) : new GistClient();
  const result = await gistClient.getGist(gistId);
  if (!result.ok) {
    const status = result.error?.statusCode ?? undefined;
    const category = result.error?.category;

    if (status === 404) {
      throw new Error(
        `Gist not found. If it's private, make sure your GitHub token is configured (Cursor Sync: Configure GitHub).`
      );
    }
    if (status === 401 || status === 403 || category === "AUTH_FAILED") {
      throw new Error("Authentication failed. Check your GitHub token has Gist read access.");
    }
    if (result.error?.category === "NETWORK_ERROR") {
      throw new Error(result.error?.message ?? "Network error while fetching Gist");
    }
    throw new Error(result.error?.message ?? `Failed to fetch Gist: ${status ?? 0}`);
  }
  return result.data as { files?: Record<string, { content?: string }> };
}

async function readEncryptedOrPlainGistFile(
  context: vscode.ExtensionContext,
  gistFiles: Record<string, { content?: string }>,
  token: string,
  logicalName: string,
  plainFile?: GistFile
): Promise<string | undefined> {
  if (tryReadGistE2eMarker(gistFiles)) {
    const unlocked = await requireE2eUnlocked(context);
    if (!isE2eDekUnlocked(unlocked)) {
      throw new Error(unlocked.ok ? GIST_LOCKED_MESSAGE : unlocked.message);
    }
    return readLogicalFileFromGistMap(
      unlocked.dek,
      unlocked.userId,
      unlocked.keyVersion,
      gistFiles,
      logicalName
    );
  }
  if (!plainFile) {
    return undefined;
  }
  return fetchGistFileContent(plainFile, token);
}

function extractGistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1]!;

  if (/^[A-Za-z0-9-]+$/.test(trimmed)) return trimmed;

  return null;
}
