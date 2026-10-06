import * as vscode from "vscode";
import { GIST_E2E_MARKER_FILE } from "./constants.js";
import { envelopeFromBase64Wire, isValidCse1EnvelopeBytes } from "./envelope.js";
import { deriveGistFileNameHex } from "./key-material.js";
import { isE2eDekUnlocked, requireE2eUnlocked } from "./gate.js";
import { tryReadGistE2eMarker } from "./gist-bundle.js";
import { decryptGistFileContent } from "./gist-e2e.js";

export const GIST_LOCKED_MESSAGE =
  "This Gist is encrypted. Unlock Cursor Sync with your sync passphrase or recovery key.";

export function isBase64Cse1Envelope(raw: string): boolean {
  try {
    const buf = envelopeFromBase64Wire(raw.trim());
    return isValidCse1EnvelopeBytes(buf);
  } catch {
    return false;
  }
}

export function remoteGistHasE2eMarker(
  files: Record<string, { content?: string } | undefined>
): boolean {
  return tryReadGistE2eMarker(files as Record<string, { content?: string }>) !== undefined;
}

export async function assertCanReadE2eGist(
  context: vscode.ExtensionContext,
  files: Record<string, { content?: string } | undefined>
): Promise<
  | { ok: true; dek: Buffer; userId: string; keyVersion: number }
  | { ok: false; message: string }
> {
  if (!remoteGistHasE2eMarker(files)) {
    return {
      ok: false,
      message: "Internal error: assertCanReadE2eGist called without marker.",
    };
  }
  const unlocked = await requireE2eUnlocked(context);
  if (!isE2eDekUnlocked(unlocked)) {
    return {
      ok: false,
      message: unlocked.ok ? GIST_LOCKED_MESSAGE : unlocked.message,
    };
  }
  const marker = tryReadGistE2eMarker(files as Record<string, { content?: string }>);
  if (marker && marker.keyVersion !== unlocked.keyVersion) {
    return {
      ok: false,
      message: "This Gist was encrypted with a different key version. Unlock with the correct account.",
    };
  }
  return {
    ok: true,
    dek: unlocked.dek,
    userId: unlocked.userId,
    keyVersion: unlocked.keyVersion,
  };
}

export function readLogicalFileFromGistMap(
  dek: Buffer,
  userId: string,
  keyVersion: number,
  files: Record<string, { content?: string }>,
  logicalName: string
): string | undefined {
  const encName = deriveGistFileNameHex(dek, logicalName);
  const direct = files[logicalName]?.content;
  if (direct !== undefined && !isBase64Cse1Envelope(direct)) {
    return direct;
  }
  const enc = files[encName]?.content ?? (direct && isBase64Cse1Envelope(direct) ? direct : undefined);
  if (!enc) {
    return undefined;
  }
  if (!isBase64Cse1Envelope(enc)) {
    return enc;
  }
  return decryptGistFileContent(dek, enc, userId, keyVersion, logicalName);
}

export function listPlaintextGistFilesForMigration(
  files: Record<string, { content?: string } | undefined>,
  encryptedFileNames: Set<string>
): string[] {
  const out: string[] = [];
  for (const name of Object.keys(files)) {
    if (name === GIST_E2E_MARKER_FILE) {
      continue;
    }
    if (encryptedFileNames.has(name)) {
      continue;
    }
    out.push(name);
  }
  return out;
}

export function encryptedGistFileNamesForLogical(
  dek: Buffer,
  logicalNames: string[]
): Set<string> {
  const set = new Set<string>();
  for (const logical of logicalNames) {
    set.add(deriveGistFileNameHex(dek, logical));
  }
  set.add(GIST_E2E_MARKER_FILE);
  return set;
}
