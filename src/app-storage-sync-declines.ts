import type * as vscode from "vscode";

const STORAGE_KEY = "appStorage.syncDeclines.v2";

export interface SyncDeclineEntry {
  /** Local checksum when user declined a pull overwrite; push blocked while unchanged. */
  pullOverwriteChecksum?: string;
  /** User declined applying a remote-side delete locally; push must not re-upload. */
  keepLocalAgainstRemoteDelete?: boolean;
}

type DeclineStore = Record<string, SyncDeclineEntry>;

async function readStore(context: vscode.ExtensionContext): Promise<DeclineStore> {
  return (context.globalState.get<DeclineStore>(STORAGE_KEY) ?? {}) as DeclineStore;
}

async function writeStore(
  context: vscode.ExtensionContext,
  store: DeclineStore
): Promise<void> {
  await context.globalState.update(STORAGE_KEY, store);
}

export async function recordDeclinedPullOverwrite(
  context: vscode.ExtensionContext,
  syncKey: string,
  localChecksum: string | undefined
): Promise<void> {
  const store = await readStore(context);
  store[syncKey] = {
    ...store[syncKey],
    pullOverwriteChecksum: localChecksum ?? "",
  };
  await writeStore(context, store);
}

export async function recordDeclinedLocalDelete(
  context: vscode.ExtensionContext,
  syncKey: string
): Promise<void> {
  const store = await readStore(context);
  store[syncKey] = {
    ...store[syncKey],
    keepLocalAgainstRemoteDelete: true,
  };
  await writeStore(context, store);
}

export async function clearSyncDeclines(
  context: vscode.ExtensionContext,
  syncKeys: string[]
): Promise<void> {
  if (syncKeys.length === 0) {
    return;
  }
  const store = await readStore(context);
  for (const key of syncKeys) {
    delete store[key];
  }
  await writeStore(context, store);
}

export async function clearAllSyncDeclines(
  context: vscode.ExtensionContext
): Promise<void> {
  await writeStore(context, {});
}

export async function shouldBlockPushForDecline(
  context: vscode.ExtensionContext,
  syncKey: string,
  localChecksum: string | undefined,
  trigger: string
): Promise<boolean> {
  const store = await readStore(context);
  const entry = store[syncKey];
  if (!entry) {
    return false;
  }
  if (entry.keepLocalAgainstRemoteDelete) {
    return true;
  }
  if (entry.pullOverwriteChecksum !== undefined) {
    const declinedAt = entry.pullOverwriteChecksum;
    const current = localChecksum ?? "";
    if (current !== declinedAt) {
      return false;
    }
    if (trigger === "manual" || trigger === "syncNow") {
      return false;
    }
    return true;
  }
  return false;
}

export async function filterPushKeysRespectingDeclines(
  context: vscode.ExtensionContext,
  keys: string[],
  localChecksums: Record<string, string>,
  trigger: string,
  explicitPush: boolean
): Promise<string[]> {
  const store = await readStore(context);
  const out: string[] = [];
  for (const key of keys) {
    const entry = store[key];
    if (!entry) {
      out.push(key);
      continue;
    }
    if (entry.keepLocalAgainstRemoteDelete) {
      continue;
    }
    if (entry.pullOverwriteChecksum !== undefined) {
      const current = localChecksums[key] ?? "";
      if (current !== entry.pullOverwriteChecksum) {
        out.push(key);
        continue;
      }
      if (explicitPush && (trigger === "manual" || trigger === "syncNow")) {
        out.push(key);
        continue;
      }
      continue;
    }
    out.push(key);
  }
  return out;
}

export async function pruneResolvedDeclines(
  context: vscode.ExtensionContext,
  localChecksums: Record<string, string>
): Promise<void> {
  const store = await readStore(context);
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (entry.pullOverwriteChecksum !== undefined) {
      const current = localChecksums[key] ?? "";
      if (current !== entry.pullOverwriteChecksum) {
        delete store[key];
        changed = true;
      }
    }
  }
  if (changed) {
    await writeStore(context, store);
  }
}
