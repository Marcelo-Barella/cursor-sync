import type { AppStorageBaseline } from "./app-storage-baseline.js";

export const GENERATED_EXTENSIONS_SYNC_KEY = "cursor-user/extensions.json";

export function alignGeneratedOnlyLocalChecksums(
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>,
  baseline: AppStorageBaseline | undefined,
  extensionsEmpty: boolean
): Record<string, string> {
  if (!extensionsEmpty) {
    return localChecksums;
  }
  const key = GENERATED_EXTENSIONS_SYNC_KEY;
  const aligned = { ...localChecksums };
  const baselineRemote = baseline?.remoteChecksums[key];
  const baselineLocal = baseline?.localChecksums[key];
  const remote = remoteChecksums[key];
  if (baselineRemote !== undefined) {
    aligned[key] = baselineRemote;
  } else if (baselineLocal !== undefined) {
    aligned[key] = baselineLocal;
  } else if (remote !== undefined) {
    aligned[key] = remote;
  } else {
    delete aligned[key];
  }
  return aligned;
}
