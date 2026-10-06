import * as vscode from "vscode";
import {
  decryptChatGistPayload,
  isEncryptedChatGistPayload,
  ChatGistCryptoError,
  type PlaintextKind,
} from "../chat-gist-crypto.js";
import { requireE2eUnlocked } from "./gate.js";
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
  if (!unlocked.ok) {
    throw new Error(unlocked.message);
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
  if (!unlocked.ok) {
    throw new Error(
      "This chat Gist is encrypted with sync encryption. Unlock Cursor Sync first."
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
  plaintext: string,
  logicalFileName: string,
  legacyKind: PlaintextKind
): Promise<Record<string, { content: string }>> {
  return encryptChatPayloadForGist(context, plaintext, logicalFileName, legacyKind);
}
