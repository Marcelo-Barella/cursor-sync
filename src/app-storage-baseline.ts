import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { SyncDestinationId } from "./sync-destination.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";
import { accountKeyFromAppSession } from "./app-session-identity.js";

export const APP_STORAGE_BASELINE_SCHEMA_VERSION = 1 as const;
export const APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION = 2 as const;

export interface AppStorageBaseline {
  schemaVersion: typeof APP_STORAGE_BASELINE_SCHEMA_VERSION;
  accountKey: string;
  destination: SyncDestinationId;
  remoteUpdatedAt: string;
  localChecksums: Record<string, string>;
  remoteChecksums: Record<string, string>;
}

interface AppStorageBaselineStoreV2 {
  schemaVersion: typeof APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION;
  accounts: Record<string, AppStorageBaseline>;
}

export type AppStorageKeyClassification =
  | "unchanged"
  | "push"
  | "pull"
  | "conflict"
  | "delete"
  | "baseline_refresh"
  | "remote_delete";

export interface ClassifiedAppStorageKeys {
  byKey: Record<string, AppStorageKeyClassification>;
  pushKeys: string[];
  pullKeys: string[];
  conflictKeys: string[];
  deleteKeys: string[];
  remoteDeleteKeys: string[];
  baselineRefreshKeys: string[];
  unchangedKeys: string[];
  hasBaseline: boolean;
}

export function shouldPullAppConfigFile(
  localChecksum: string | undefined,
  remoteChecksum: string
): boolean {
  if (localChecksum === undefined) {
    return true;
  }
  return localChecksum !== remoteChecksum;
}

function baselinePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "app-storage-baseline.json");
}

export function baselineKeyTracked(baseline: AppStorageBaseline, key: string): boolean {
  return (
    baseline.localChecksums[key] !== undefined ||
    baseline.remoteChecksums[key] !== undefined
  );
}

export function filterScheduledAppStoragePullKeys(
  keys: string[],
  baseline: AppStorageBaseline | undefined
): string[] {
  if (!baselineHasEntries(baseline)) {
    return [];
  }
  return keys.filter((key) => baselineKeyTracked(baseline!, key));
}

export function baselineHasEntries(baseline: AppStorageBaseline | undefined): boolean {
  if (!baseline) {
    return false;
  }
  return (
    Object.keys(baseline.localChecksums).length > 0 ||
    Object.keys(baseline.remoteChecksums).length > 0
  );
}

async function readBaselineStore(
  context: vscode.ExtensionContext,
  migrateToAccountKey: string,
  session?: string
): Promise<AppStorageBaselineStoreV2> {
  const filePath = baselinePath(context);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as AppStorageBaselineStoreV2).schemaVersion ===
        APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION &&
      typeof (parsed as AppStorageBaselineStoreV2).accounts === "object"
    ) {
      return parsed as AppStorageBaselineStoreV2;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as AppStorageBaseline).schemaVersion === APP_STORAGE_BASELINE_SCHEMA_VERSION &&
      typeof (parsed as AppStorageBaseline).accountKey === "string"
    ) {
      const legacy = parsed as AppStorageBaseline;
      const legacySessionKey = session ? accountKeyFromAppSession(session) : undefined;
      const attributable =
        legacy.accountKey === migrateToAccountKey ||
        (legacySessionKey !== undefined && legacy.accountKey === legacySessionKey);
      if (!attributable) {
        return {
          schemaVersion: APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION,
          accounts: {},
        };
      }
      const migrated: AppStorageBaseline = {
        ...legacy,
        accountKey: migrateToAccountKey,
      };
      return {
        schemaVersion: APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION,
        accounts: { [migrateToAccountKey]: migrated },
      };
    }
  } catch {
  }
  return {
    schemaVersion: APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION,
    accounts: {},
  };
}

async function writeBaselineStore(
  context: vscode.ExtensionContext,
  store: AppStorageBaselineStoreV2
): Promise<void> {
  const filePath = baselinePath(context);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

export async function loadAppStorageBaseline(
  context: vscode.ExtensionContext,
  accountKey: string,
  destination: SyncDestinationId = "cursor-sync-storage",
  session?: string
): Promise<AppStorageBaseline | undefined> {
  const store = await readBaselineStore(context, accountKey, session);
  const baseline = store.accounts[accountKey];
  if (!baseline || baseline.destination !== destination) {
    return undefined;
  }
  return baseline;
}

export async function saveAppStorageBaseline(
  context: vscode.ExtensionContext,
  baseline: AppStorageBaseline
): Promise<void> {
  const store = await readBaselineStore(context, baseline.accountKey, undefined);
  store.accounts[baseline.accountKey] = baseline;
  await writeBaselineStore(context, store);
}

export function classifyAppStorageKeys(
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>,
  baseline: AppStorageBaseline | undefined,
  localScan?: LocalConfigFileScan
): ClassifiedAppStorageKeys {
  const unreadable = localScan?.unreadableKeys ?? new Set<string>();
  const byKey: Record<string, AppStorageKeyClassification> = {};
  const pushKeys: string[] = [];
  const pullKeys: string[] = [];
  const conflictKeys: string[] = [];
  const deleteKeys: string[] = [];
  const remoteDeleteKeys: string[] = [];
  const baselineRefreshKeys: string[] = [];
  const unchangedKeys: string[] = [];

  const hasBaseline = baselineHasEntries(baseline);
  const baseLocal = baseline?.localChecksums ?? {};
  const baseRemote = baseline?.remoteChecksums ?? {};

  const allKeys = new Set([
    ...Object.keys(localChecksums),
    ...Object.keys(remoteChecksums),
    ...Object.keys(baseLocal),
    ...Object.keys(baseRemote),
  ]);

  for (const key of allKeys) {
    const curLocal = localChecksums[key];
    const curRemote = remoteChecksums[key];
    const wasLocal = baseLocal[key];
    const wasRemote = baseRemote[key];

    if (hasBaseline && wasLocal !== undefined && curLocal === undefined) {
      if (unreadable.has(key)) {
        byKey[key] = "unchanged";
        unchangedKeys.push(key);
        continue;
      }
      if (wasRemote !== undefined && curRemote === undefined) {
        byKey[key] = "baseline_refresh";
        baselineRefreshKeys.push(key);
        continue;
      }
      if (curRemote !== wasRemote) {
        byKey[key] = "conflict";
        conflictKeys.push(key);
        continue;
      }
      byKey[key] = "delete";
      deleteKeys.push(key);
      continue;
    }

    if (
      hasBaseline &&
      wasRemote !== undefined &&
      curRemote === undefined &&
      curLocal === wasLocal
    ) {
      byKey[key] = "remote_delete";
      remoteDeleteKeys.push(key);
      continue;
    }

    if (!hasBaseline) {
      const remoteExists = curRemote !== undefined;
      const localExists = curLocal !== undefined;
      if (remoteExists && localExists) {
        if (curLocal === curRemote) {
          byKey[key] = "baseline_refresh";
          baselineRefreshKeys.push(key);
        } else {
          byKey[key] = "conflict";
          conflictKeys.push(key);
        }
      } else if (remoteExists && !localExists) {
        byKey[key] = "pull";
        pullKeys.push(key);
      } else if (!remoteExists && localExists) {
        byKey[key] = "push";
        pushKeys.push(key);
      } else {
        byKey[key] = "unchanged";
        unchangedKeys.push(key);
      }
      continue;
    }

    const localChanged = curLocal !== wasLocal;
    const remoteChanged = curRemote !== wasRemote;

    if (!localChanged && !remoteChanged) {
      byKey[key] = "unchanged";
      unchangedKeys.push(key);
      continue;
    }

    if (localChanged && remoteChanged) {
      if (curLocal === curRemote) {
        byKey[key] = "baseline_refresh";
        baselineRefreshKeys.push(key);
      } else {
        byKey[key] = "conflict";
        conflictKeys.push(key);
      }
      continue;
    }

    if (localChanged) {
      byKey[key] = "push";
      pushKeys.push(key);
      continue;
    }

    if (curRemote === undefined) {
      byKey[key] = "remote_delete";
      remoteDeleteKeys.push(key);
      continue;
    }

    byKey[key] = "pull";
    pullKeys.push(key);
  }

  return {
    byKey,
    pushKeys,
    pullKeys,
    conflictKeys,
    deleteKeys,
    remoteDeleteKeys,
    baselineRefreshKeys,
    unchangedKeys,
    hasBaseline,
  };
}

export type DerivedAppStorageSyncAction =
  | { action: "none" }
  | { action: "pull"; keys: string[]; remoteDeletions: string[] }
  | { action: "push"; keys: string[]; deletions: string[] }
  | { action: "conflict"; keys: string[] }
  | { action: "baseline_refresh"; keys: string[] };

function pullActionKeys(classified: ClassifiedAppStorageKeys): string[] {
  return [...new Set([...classified.pullKeys, ...classified.baselineRefreshKeys])];
}

export function appStorageSyncActionFromClassification(
  classified: ClassifiedAppStorageKeys,
  remoteChecksums: Record<string, string>
): DerivedAppStorageSyncAction {
  const remoteNonempty = Object.keys(remoteChecksums).length > 0;
  const pullKeys = [...classified.pullKeys, ...classified.remoteDeleteKeys];

  if (classified.conflictKeys.length > 0) {
    return { action: "conflict", keys: classified.conflictKeys };
  }

  if (!classified.hasBaseline && remoteNonempty) {
    if (pullKeys.length > 0 && classified.pushKeys.length === 0) {
      return {
        action: "pull",
        keys: pullActionKeys(classified),
        remoteDeletions: classified.remoteDeleteKeys,
      };
    }
    if (classified.pushKeys.length > 0 && pullKeys.length === 0) {
      return {
        action: "push",
        keys: classified.pushKeys,
        deletions: classified.deleteKeys,
      };
    }
    if (pullKeys.length > 0 || classified.pushKeys.length > 0) {
      return {
        action: "pull",
        keys: pullActionKeys(classified),
        remoteDeletions: classified.remoteDeleteKeys,
      };
    }
  }

  const hasPush =
    classified.pushKeys.length > 0 || classified.deleteKeys.length > 0;
  const hasPull = pullKeys.length > 0;

  if (hasPull && hasPush) {
    return {
      action: "conflict",
      keys: [...classified.pushKeys, ...pullKeys],
    };
  }
  if (hasPull) {
    return {
      action: "pull",
      keys: pullActionKeys(classified),
      remoteDeletions: classified.remoteDeleteKeys,
    };
  }
  if (hasPush) {
    return {
      action: "push",
      keys: classified.pushKeys,
      deletions: classified.deleteKeys,
    };
  }

  if (classified.baselineRefreshKeys.length > 0) {
    return { action: "baseline_refresh", keys: classified.baselineRefreshKeys };
  }

  return { action: "none" };
}

export async function updateAppStorageBaselineAfterSync(
  context: vscode.ExtensionContext,
  input: {
    accountKey: string;
    destination: SyncDestinationId;
    remoteUpdatedAt: string;
    syncedKeys: string[];
    deletedKeys: string[];
    localChecksums: Record<string, string>;
    remoteChecksums: Record<string, string>;
  }
): Promise<void> {
  const existing =
    (await loadAppStorageBaseline(context, input.accountKey, input.destination)) ?? {
      schemaVersion: APP_STORAGE_BASELINE_SCHEMA_VERSION,
      accountKey: input.accountKey,
      destination: input.destination,
      remoteUpdatedAt: input.remoteUpdatedAt,
      localChecksums: {},
      remoteChecksums: {},
    };

  const nextLocal = { ...existing.localChecksums };
  const nextRemote = { ...existing.remoteChecksums };

  for (const key of input.syncedKeys) {
    if (input.localChecksums[key] !== undefined) {
      nextLocal[key] = input.localChecksums[key]!;
    }
    if (input.remoteChecksums[key] !== undefined) {
      nextRemote[key] = input.remoteChecksums[key]!;
    }
  }

  for (const key of input.deletedKeys) {
    delete nextLocal[key];
    delete nextRemote[key];
  }

  await saveAppStorageBaseline(context, {
    schemaVersion: APP_STORAGE_BASELINE_SCHEMA_VERSION,
    accountKey: input.accountKey,
    destination: input.destination,
    remoteUpdatedAt: input.remoteUpdatedAt,
    localChecksums: nextLocal,
    remoteChecksums: nextRemote,
  });
}
