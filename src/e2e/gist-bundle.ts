import { GIST_E2E_MARKER_FILE } from "./constants.js";
import {
  buildGistMarkerJson,
  encryptGistFileContent,
} from "./gist-e2e.js";

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
