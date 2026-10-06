import { GIST_E2E_MARKER_FILE } from "./constants.js";
import {
  buildGistMarkerJson,
  decryptGistFileContent,
  encryptGistFileContent,
  isGistE2eMarkerFileName,
} from "./gist-e2e.js";
import { deriveGistFileNameHex } from "./key-material.js";

export function wrapGistFilesForUpload(
  dek: Buffer,
  userId: string,
  keyVersion: number,
  logicalFiles: Record<string, { content: string }>
): Record<string, { content: string }> {
  const out: Record<string, { content: string }> = {};
  for (const [logicalName, file] of Object.entries(logicalFiles)) {
    const enc = encryptGistFileContent(dek, file.content, userId, keyVersion, logicalName);
    out[enc.gistFileName] = { content: enc.content };
  }
  out[GIST_E2E_MARKER_FILE] = { content: buildGistMarkerJson(keyVersion) };
  return out;
}

export function tryReadGistE2eMarker(
  files: Record<string, { content?: string }>
): { keyVersion: number } | undefined {
  const marker = files[GIST_E2E_MARKER_FILE];
  if (!marker?.content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(marker.content) as { format?: string; keyVersion?: number };
    if (parsed.format !== "CSE1" || typeof parsed.keyVersion !== "number") {
      return undefined;
    }
    return { keyVersion: parsed.keyVersion };
  } catch {
    return undefined;
  }
}

export function readEncryptedGistLogicalFile(
  dek: Buffer,
  remoteFiles: Record<string, { content?: string }>,
  logicalName: string,
  userId: string,
  keyVersion: number
): string | undefined {
  const encName = deriveGistFileNameHex(dek, logicalName);
  const file = remoteFiles[encName];
  if (!file?.content) {
    return undefined;
  }
  return decryptGistFileContent(dek, file.content, userId, keyVersion, logicalName);
}

export function decryptGistFilesFromRemote(
  dek: Buffer,
  userId: string,
  keyVersion: number,
  remoteFiles: Record<string, { content?: string }>,
  logicalNameForEncryptedFile: (encryptedFileName: string) => string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [fileName, file] of Object.entries(remoteFiles)) {
    if (isGistE2eMarkerFileName(fileName) || !file.content) {
      continue;
    }
    const logical = logicalNameForEncryptedFile(fileName);
    if (!logical) {
      continue;
    }
    out[logical] = decryptGistFileContent(dek, file.content, userId, keyVersion, logical);
  }
  return out;
}
