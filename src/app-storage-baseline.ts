import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { SyncDestinationId } from "./sync-destination.js";
import type { LocalConfigFileScan } from "./app-config-local-scan.js";
import { decideSyncKey } from "./app-storage-sync-decisions.js";
import type { SyncDeclineEntry } from "./app-storage-sync-declines.js";
import { accountKeyFromAppSession } from "./app-session-identity.js";

export {
  filterScheduledAppStoragePullKeys,
  pullOverwriteShouldBePreselected,
} from "./app-storage-sync-decisions.js";

export const APP_STORAGE_BASELINE_SCHEMA_VERSION = 1 as const;
export const APP_STORAGE_BASELINE_STORE_SCHEMA_VERSION = 2 as const;

export interface AppStorageBaseline {
  schemaVersion: typeof APP_STORAGE_BASELINE_SCHEMA_VERSION;
  accountKey: string;
  destination: SyncDestinationId;
  remoteUpdatedAt: string;
  localChecksums: Record<string, string>;
  remoteChecksums: Record<string, string>;
  trackingScope?: {
    enabledPaths: string[];
    excludeGlobs: string[];
    maxFileSizeKB: number;
  };
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

export function remoteChecksumChangedSinceBaseline(
  syncKey: string,
  remoteChecksum: string,
  baseline: AppStorageBaseline | undefined
): boolean {
  if (!baseline) {
    return true;
  }
  const priorRemote = baseline.remoteChecksums[syncKey];
  if (priorRemote === undefined) {
    return true;
  }
  return priorRemote !== remoteChecksum;
}

export function needsPullAppConfigFile(
  syncKey: string,
  localChecksum: string | undefined,
  remoteChecksum: string,
  baseline: AppStorageBaseline | undefined
): boolean {
  if (!remoteChecksumChangedSinceBaseline(syncKey, remoteChecksum, baseline)) {
    return false;
  }
  return shouldPullAppConfigFile(localChecksum, remoteChecksum);
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

export async function clearAllAppStorageBaselines(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    await fs.unlink(baselinePath(context));
  } catch {
  }
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
  localScan?: LocalConfigFileScan,
  declines?: Record<string, SyncDeclineEntry>
): ClassifiedAppStorageKeys {
  const scan: LocalConfigFileScan =
    localScan ?? {
      checksums: localChecksums,
      unreadableKeys: new Set(),
      excludedKeys: new Set(),
      oversizeKeys: new Set(),
      symlinkKeys: new Set(),
      enoentKeys: new Set(),
      provablyAbsentKeys: new Set(),
      skippedUnknownKeys: new Set(),
      untrackedKeys: new Set(),
      absentEligibleKeys: new Set(),
      deletesAllowed: true,
      enumeratedCount: Object.keys(localChecksums).length,
      rootsHealthy: true,
      deleteBlockedRootPrefixes: new Set(),
      trackingScopeMismatch: false,
    };

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

  const scanForDecision: LocalConfigFileScan = {
    ...scan,
    checksums: { ...scan.checksums, ...localChecksums },
  };

  for (const key of allKeys) {
    const curLocal = localChecksums[key];
    const curRemote = remoteChecksums[key];
    const decision = decideSyncKey({
      syncKey: key,
      scan: scanForDecision,
      baseline,
      curLocal,
      curRemote,
      declines: declines?.[key],
    });

    let classification: AppStorageKeyClassification;
    switch (decision.action) {
      case "push":
        classification = "push";
        pushKeys.push(key);
        break;
      case "pull":
        classification = "pull";
        pullKeys.push(key);
        break;
      case "delete_remote":
        classification = "delete";
        deleteKeys.push(key);
        break;
      case "delete_local":
        classification = "remote_delete";
        remoteDeleteKeys.push(key);
        break;
      case "conflict":
        classification = "conflict";
        conflictKeys.push(key);
        break;
      case "baseline_refresh":
        classification = "baseline_refresh";
        baselineRefreshKeys.push(key);
        break;
      default:
        classification = "unchanged";
        unchangedKeys.push(key);
        break;
    }
    byKey[key] = classification;
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
  | { action: "pull-push"; pullKeys: string[]; remoteDeletions: string[]; pushKeys: string[]; deletions: string[] }
  | { action: "conflict"; keys: string[] }
  | { action: "baseline_refresh"; keys: string[] };

export function appStorageSyncActionFromClassification(
  classified: ClassifiedAppStorageKeys,
  remoteChecksums: Record<string, string>
): DerivedAppStorageSyncAction {
  const remoteNonempty = Object.keys(remoteChecksums).length > 0;
  const pullKeys = [
    ...classified.pullKeys,
    ...classified.remoteDeleteKeys.filter(
      (k) => classified.byKey[k] === "remote_delete"
    ),
  ];
  const pushKeysEffective = classified.pushKeys.filter(
    (k) => classified.byKey[k] === "push"
  );
  const deleteKeysEffective = classified.deleteKeys.filter(
    (k) => classified.byKey[k] === "delete"
  );

  const conflictKeysEffective = classified.conflictKeys.filter(
    (k) => classified.byKey[k] === "conflict"
  );

  if (conflictKeysEffective.length > 0) {
    return { action: "conflict", keys: conflictKeysEffective };
  }

  if (!classified.hasBaseline && remoteNonempty) {
    if (pullKeys.length > 0 && pushKeysEffective.length === 0) {
      return {
        action: "pull",
        keys: classified.pullKeys,
        remoteDeletions: classified.remoteDeleteKeys,
      };
    }
    if (pushKeysEffective.length > 0 && pullKeys.length === 0) {
      return {
        action: "push",
        keys: classified.pushKeys,
        deletions: classified.deleteKeys,
      };
    }
    if (pullKeys.length > 0 || pushKeysEffective.length > 0) {
      return {
        action: "pull",
        keys: classified.pullKeys,
        remoteDeletions: classified.remoteDeleteKeys,
      };
    }
  }

  const hasPush = pushKeysEffective.length > 0 || deleteKeysEffective.length > 0;
  const hasPull = pullKeys.length > 0;

  if (hasPull && hasPush) {
    return {
      action: "pull-push",
      pullKeys: classified.pullKeys,
      remoteDeletions: classified.remoteDeleteKeys,
      pushKeys: classified.pushKeys,
      deletions: classified.deleteKeys,
    };
  }
  if (hasPull) {
    return {
      action: "pull",
      keys: classified.pullKeys,
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
    trackingScope?: AppStorageBaseline["trackingScope"];
    pruneUntrackedKeys?: Iterable<string>;
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

  if (input.pruneUntrackedKeys) {
    for (const key of input.pruneUntrackedKeys) {
      delete nextLocal[key];
      delete nextRemote[key];
    }
  }

  await saveAppStorageBaseline(context, {
    schemaVersion: APP_STORAGE_BASELINE_SCHEMA_VERSION,
    accountKey: input.accountKey,
    destination: input.destination,
    remoteUpdatedAt: input.remoteUpdatedAt,
    localChecksums: nextLocal,
    remoteChecksums: nextRemote,
    trackingScope: input.trackingScope ?? existing.trackingScope,
  });
}

export async function updateAppStorageBaselineTrackingScope(
  context: vscode.ExtensionContext,
  accountKey: string,
  destination: SyncDestinationId,
  trackingScope: AppStorageBaseline["trackingScope"]
): Promise<void> {
  const existing = await loadAppStorageBaseline(context, accountKey, destination);
  if (!existing) {
    return;
  }
  await saveAppStorageBaseline(context, { ...existing, trackingScope });
}
