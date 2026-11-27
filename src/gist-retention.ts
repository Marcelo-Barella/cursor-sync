import {
  classifyUnselectedSyncKey,
  gistFileNameToSyncKey,
  type SyncRoots,
} from "./paths.js";
import type { Manifest, ManifestFileEntry } from "./types.js";

export interface GistRetentionDecision {
  filesToDelete: Record<string, null>;
  retainedChecksums: Record<string, string>;
  retainedManifestFiles: Record<string, ManifestFileEntry>;
}

export function parseGistManifest(
  content: string | undefined
): Manifest | undefined {
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as Manifest;
    if (
      parsed?.schemaVersion === 1 &&
      parsed.files !== null &&
      typeof parsed.files === "object" &&
      !Array.isArray(parsed.files)
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function planGistFileRetention(
  existingFileNames: string[],
  uploadingGistNames: Set<string>,
  roots: SyncRoots,
  previousManifest?: Manifest
): Promise<GistRetentionDecision> {
  const filesToDelete: Record<string, null> = {};
  const retainedChecksums: Record<string, string> = {};
  const retainedManifestFiles: Record<string, ManifestFileEntry> = {};

  for (const existing of existingFileNames) {
    if (existing === "manifest.json" || uploadingGistNames.has(existing)) {
      continue;
    }
    const syncKey = gistFileNameToSyncKey(existing);
    const classification = await classifyUnselectedSyncKey(syncKey, roots);
    if (classification === "absent") {
      filesToDelete[existing] = null;
      continue;
    }
    const previousEntry = previousManifest?.files[syncKey];
    if (previousEntry) {
      retainedManifestFiles[syncKey] = previousEntry;
      retainedChecksums[syncKey] = previousEntry.checksum;
    }
  }

  return { filesToDelete, retainedChecksums, retainedManifestFiles };
}
