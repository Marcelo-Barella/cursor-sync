export function syncKeyRootPrefix(
  syncKey: string
): "cursor-user/" | "dot-cursor/" | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    return "cursor-user/";
  }
  if (syncKey.startsWith("dot-cursor/")) {
    return "dot-cursor/";
  }
  return undefined;
}

export function baselineHasKeysUnderPrefix(
  prefix: "cursor-user/" | "dot-cursor/",
  baselineLocalKeys: string[] | undefined
): boolean {
  if (!baselineLocalKeys || baselineLocalKeys.length === 0) {
    return false;
  }
  return baselineLocalKeys.some((k) => k.startsWith(prefix));
}

export function baselineHasKeysForSyncKey(
  syncKey: string,
  baselineLocalKeys: string[] | undefined
): boolean {
  const prefix = syncKeyRootPrefix(syncKey);
  if (!prefix) {
    return false;
  }
  return baselineHasKeysUnderPrefix(prefix, baselineLocalKeys);
}
