import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { SyncDestinationId } from "./sync-destination.js";

export const APP_STORAGE_BASELINE_SCHEMA_VERSION = 1 as const;

export interface AppStorageBaseline {
  schemaVersion: typeof APP_STORAGE_BASELINE_SCHEMA_VERSION;
  accountKey: string;
  destination: SyncDestinationId;
  remoteUpdatedAt: string;
  localChecksums: Record<string, string>;
  remoteChecksums: Record<string, string>;
}

export type AppStorageKeyClassification =
  | "unchanged"
  | "push"
  | "pull"
  | "conflict"
  | "delete"
  | "baseline_refresh";

export interface ClassifiedAppStorageKeys {
  byKey: Record<string, AppStorageKeyClassification>;
  pushKeys: string[];
  pullKeys: string[];
  conflictKeys: string[];
  deleteKeys: string[];
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

export function accountKeyFromAppSession(session: string): string {
  return crypto.createHash("sha256").update(session).digest("hex").slice(0, 16);
}

function baselinePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "app-storage-baseline.json");
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

export async function loadAppStorageBaseline(
  context: vscode.ExtensionContext,
  accountKey: string,
  destination: SyncDestinationId = "cursor-sync-storage"
): Promise<AppStorageBaseline | undefined> {
  const filePath = baselinePath(context);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AppStorageBaseline;
    if (
      parsed.schemaVersion !== APP_STORAGE_BASELINE_SCHEMA_VERSION ||
      parsed.accountKey !== accountKey ||
      parsed.destination !== destination
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveAppStorageBaseline(
  context: vscode.ExtensionContext,
  baseline: AppStorageBaseline
): Promise<void> {
  const filePath = baselinePath(context);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(baseline, null, 2), "utf-8");
}

export function classifyAppStorageKeys(
  localChecksums: Record<string, string>,
  remoteChecksums: Record<string, string>,
  baseline: AppStorageBaseline | undefined
): ClassifiedAppStorageKeys {
  const byKey: Record<string, AppStorageKeyClassification> = {};
  const pushKeys: string[] = [];
  const pullKeys: string[] = [];
  const conflictKeys: string[] = [];
  const deleteKeys: string[] = [];
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
      if (curRemote !== wasRemote) {
        byKey[key] = "conflict";
        conflictKeys.push(key);
        continue;
      }
      byKey[key] = "delete";
      deleteKeys.push(key);
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

    byKey[key] = "pull";
    pullKeys.push(key);
  }

  return {
    byKey,
    pushKeys,
    pullKeys,
    conflictKeys,
    deleteKeys,
    baselineRefreshKeys,
    unchangedKeys,
    hasBaseline,
  };
}

export type DerivedAppStorageSyncAction =
  | { action: "none" }
  | { action: "pull"; keys: string[] }
  | { action: "push"; keys: string[]; deletions: string[] }
  | { action: "conflict"; keys: string[] }
  | { action: "baseline_refresh"; keys: string[] };

export function appStorageSyncActionFromClassification(
  classified: ClassifiedAppStorageKeys,
  remoteChecksums: Record<string, string>
): DerivedAppStorageSyncAction {
  const remoteNonempty = Object.keys(remoteChecksums).length > 0;

  if (classified.conflictKeys.length > 0) {
    return { action: "conflict", keys: classified.conflictKeys };
  }

  if (!classified.hasBaseline && remoteNonempty) {
    if (classified.pullKeys.length > 0 && classified.pushKeys.length === 0) {
      return { action: "pull", keys: classified.pullKeys };
    }
    if (classified.pushKeys.length > 0 && classified.pullKeys.length === 0) {
      return { action: "push", keys: classified.pushKeys, deletions: classified.deleteKeys };
    }
    if (classified.pullKeys.length > 0 || classified.pushKeys.length > 0) {
      return { action: "pull", keys: classified.pullKeys };
    }
  }

  const hasPush =
    classified.pushKeys.length > 0 || classified.deleteKeys.length > 0;
  const hasPull = classified.pullKeys.length > 0;

  if (hasPull && hasPush) {
    return {
      action: "conflict",
      keys: [...classified.pushKeys, ...classified.pullKeys],
    };
  }
  if (hasPull) {
    return { action: "pull", keys: classified.pullKeys };
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
