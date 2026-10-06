import * as vscode from "vscode";
import {
  decryptChatGistPayload,
  isEncryptedChatGistPayload,
  ChatGistCryptoError,
  type PlaintextKind,
} from "../chat-gist-crypto.js";
import { isE2eDekUnlocked, requireE2eUnlocked } from "./gate.js";
import { isBase64Cse1Envelope, readLogicalFileFromGistMap } from "./gist-read.js";
import { wrapGistFilesForUpload } from "./gist-bundle.js";
import { decryptGistFileContent } from "./gist-e2e.js";

export async function encryptChatPayloadForGist(
  context: vscode.ExtensionContext,
  plaintext: string,
  logicalFileName: string,
  legacyKind: PlaintextKind
): Promise<Record<string, { content: string }>> {
  const unlocked = await requireE2eUnlocked(context);
  if (!isE2eDekUnlocked(unlocked)) {
    throw new Error(unlocked.ok ? "Unlock sync encryption first." : unlocked.message);
  }
  return wrapGistFilesForUpload(
    unlocked.dek,
    unlocked.userId,
    unlocked.keyVersion,
    { [logicalFileName]: { content: plaintext } }
  );
}

export async function decryptChatPayloadFromGist(
  context: vscode.ExtensionContext,
  raw: string,
  logicalFileName: string,
  options?: {
    gistFiles?: Record<string, { content?: string }>;
    promptLegacyPassword?: (kind: PlaintextKind) => Promise<string | undefined>;
  }
): Promise<string> {
  if (!isEncryptedChatGistPayload(raw) && !isBase64Cse1Envelope(raw)) {
    return raw;
  }

  if (isEncryptedChatGistPayload(raw)) {
    const kind: PlaintextKind =
      logicalFileName.includes("bundles") ? "chat-bundles-collection" : "chat-bundle";
    const password = await options?.promptLegacyPassword?.(kind);
    if (!password) {
      throw new Error(`${logicalFileName}: legacy chat encryption password required.`);
    }
    try {
      return await decryptChatGistPayload(raw, password);
    } catch (err) {
      if (err instanceof ChatGistCryptoError && err.code === "DECRYPT_FAILED") {
        throw new Error("Could not decrypt legacy chat gist. Check the old chat encryption password.");
      }
      throw err;
    }
  }

  const unlocked = await requireE2eUnlocked(context);
  if (!isE2eDekUnlocked(unlocked)) {
    throw new Error(
      unlocked.ok
        ? "This chat Gist is encrypted with sync encryption. Unlock Cursor Sync first."
        : unlocked.message
    );
  }

  if (options?.gistFiles) {
    const fromMap = readLogicalFileFromGistMap(
      unlocked.dek,
      unlocked.userId,
      unlocked.keyVersion,
      options.gistFiles,
      logicalFileName
    );
    if (fromMap) {
      return fromMap;
    }
  }

  return decryptGistFileContent(
    unlocked.dek,
    raw,
    unlocked.userId,
    unlocked.keyVersion,
    logicalFileName
  );
}

export async function reexportLegacyChatUnderDek(
  context: vscode.ExtensionContext,
  gistId: string,
  plaintext: string,
  logicalFileName: string,
  legacyKind: PlaintextKind
): Promise<void> {
  const files = await encryptChatPayloadForGist(context, plaintext, logicalFileName, legacyKind);
  const { getToken } = await import("../auth.js");
  const { GistClient } = await import("../gist.js");
  const token = await getToken(context);
  if (!token || !gistId) {
    return;
  }
  const client = new GistClient(token);
  const result = await client.updateGist(gistId, files);
  if (!result.ok) {
    throw new Error(`Failed to re-encrypt Gist chat export: ${result.error.message}`);
  }
}
