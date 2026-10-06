import type * as vscode from "vscode";

const STORAGE_KEY = "appStorage.syncDeclines.v2";

export interface SyncDeclineEntry {
  pullOverwriteRemoteChecksum?: string;
  keepLocalAgainstRemoteDelete?: boolean;
  keepLocalAtChecksum?: string;
}

type DeclineStore = Record<string, SyncDeclineEntry>;

async function readStore(context: vscode.ExtensionContext): Promise<DeclineStore> {
  return (context.globalState.get<DeclineStore>(STORAGE_KEY) ?? {}) as DeclineStore;
}

export async function loadSyncDeclineStore(
  context: vscode.ExtensionContext
): Promise<DeclineStore> {
  return readStore(context);
}

async function writeStore(
  context: vscode.ExtensionContext,
  store: DeclineStore
): Promise<void> {
  await context.globalState.update(STORAGE_KEY, store);
}

function legacyPullOverwriteRemote(entry: SyncDeclineEntry): string | undefined {
  const legacy = (entry as { pullOverwriteChecksum?: string }).pullOverwriteChecksum;
  return entry.pullOverwriteRemoteChecksum ?? legacy;
}

export async function recordDeclinedPullOverwrite(
  context: vscode.ExtensionContext,
  syncKey: string,
  remoteChecksum: string | undefined
): Promise<void> {
  const store = await readStore(context);
  store[syncKey] = {
    ...store[syncKey],
    pullOverwriteRemoteChecksum: remoteChecksum ?? "",
  };
  await writeStore(context, store);
}

export async function recordDeclinedLocalDelete(
  context: vscode.ExtensionContext,
  syncKey: string,
  localChecksum: string | undefined
): Promise<void> {
  const store = await readStore(context);
  store[syncKey] = {
    ...store[syncKey],
    keepLocalAgainstRemoteDelete: true,
    keepLocalAtChecksum: localChecksum ?? "",
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

export function pullDeclineBlocksRemote(
  entry: SyncDeclineEntry | undefined,
  remoteChecksum: string | undefined
): boolean {
  const declined = entry ? legacyPullOverwriteRemote(entry) : undefined;
  if (declined === undefined) {
    return false;
  }
  return (remoteChecksum ?? "") === declined;
}

export function keepLocalDeclineBlocksDelete(
  entry: SyncDeclineEntry | undefined,
  localChecksum: string | undefined
): boolean {
  if (!entry?.keepLocalAgainstRemoteDelete) {
    return false;
  }
  const at = entry.keepLocalAtChecksum ?? "";
  return (localChecksum ?? "") === at;
}

export async function shouldBlockPushForDecline(
  context: vscode.ExtensionContext,
  syncKey: string,
  localChecksum: string | undefined,
  _trigger: string
): Promise<boolean> {
  const store = await readStore(context);
  const entry = store[syncKey];
  if (!entry) {
    return false;
  }
  return keepLocalDeclineBlocksDelete(entry, localChecksum);
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
      const at = entry.keepLocalAtChecksum ?? "";
      const current = localChecksums[key] ?? "";
      if (current !== at) {
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
  localChecksums: Record<string, string>,
  remoteChecksums?: Record<string, string>
): Promise<void> {
  const store = await readStore(context);
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (entry.keepLocalAgainstRemoteDelete) {
      const at = entry.keepLocalAtChecksum ?? "";
      const current = localChecksums[key] ?? "";
      if (current !== at) {
        delete store[key];
        changed = true;
      }
      continue;
    }
    const declinedRemote = legacyPullOverwriteRemote(entry);
    if (declinedRemote !== undefined && remoteChecksums) {
      const curRemote = remoteChecksums[key] ?? "";
      if (curRemote !== declinedRemote) {
        delete store[key];
        changed = true;
      }
    }
  }
  if (changed) {
    await writeStore(context, store);
  }
}
