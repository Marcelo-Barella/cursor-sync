import * as vscode from "vscode";
import type { AppConfigsPayloadV1 } from "../app-configs.js";
import { fetchConfigsApi } from "./configs-sync.js";
import {
  deletePlaintextR2Objects,
  listPlaintextObjectKeys,
  type PlaintextDeleteOutcome,
} from "./storage-plaintext.js";
import { loadMigrationState, saveMigrationState } from "./migration.js";
import { getLogger } from "../diagnostics.js";
import { hasLegacyConfigsPayload, isAppConfigsPayloadV1 } from "./configs-legacy-payload.js";

export function legacyPlaintextSyncKeysFromPayload(payload: AppConfigsPayloadV1): string[] {
  return Object.keys(payload.files).sort();
}

export function legacyPlaintextKeysFromConfigsResponse(
  remote: Awaited<ReturnType<typeof fetchConfigsApi>>
): string[] {
  if (!remote) {
    return [];
  }
  const fromField = remote.legacyPlaintextObjectKeys ?? [];
  const fromPayload =
    remote.payload && isAppConfigsPayloadV1(remote.payload)
      ? legacyPlaintextSyncKeysFromPayload(remote.payload)
      : [];
  return unionKeys(fromField, fromPayload);
}

function unionKeys(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}

export interface LegacyPlaintextCleanupResult {
  deleted: string[];
  failed: string[];
  partial: boolean;
  remainingKeys: string[];
  legacyPayloadPresent: boolean;
}

export async function runLegacyPlaintextCleanup(
  context: vscode.ExtensionContext,
  options?: {
    extraKeysFromConfigs?: string[];
    prefetchedPlaintextObjectKeys?: string[];
  }
): Promise<LegacyPlaintextCleanupResult> {
  const logger = getLogger();
  const remote = await fetchConfigsApi(context);
  const legacyPayloadPresent = hasLegacyConfigsPayload(remote?.payload);

  const serverKeys =
    options?.prefetchedPlaintextObjectKeys ?? (await listPlaintextObjectKeys(context));
  const keysToDelete = unionKeys(serverKeys, options?.extraKeysFromConfigs ?? []);

  let deleteOutcome: PlaintextDeleteOutcome = {
    settled: [],
    failed: [],
    partial: false,
    results: [],
  };

  if (keysToDelete.length > 0) {
    deleteOutcome = await deletePlaintextR2Objects(context, keysToDelete);
    if (deleteOutcome.failed.length > 0 || deleteOutcome.partial) {
      const message = `Plaintext cleanup incomplete for ${deleteOutcome.failed.length || "some"} object(s). Will retry on next sync.`;
      logger.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  }

  const remainingKeys =
    deleteOutcome.settled.length > 0
      ? await listPlaintextObjectKeys(context)
      : keysToDelete.filter((k) => !deleteOutcome.settled.includes(k));

  const migration = await loadMigrationState(context);
  if (migration) {
    const completed = new Set(migration.completedPlaintextR2Keys ?? []);
    for (const key of deleteOutcome.settled) {
      completed.add(key);
    }
    await saveMigrationState(context, {
      phase: migration.phase,
      completedPlaintextR2Keys: [...completed],
      completedPlaintextGistFiles: migration.completedPlaintextGistFiles,
      legacyPayloadCleared: !legacyPayloadPresent && remainingKeys.length === 0,
    });
  }

  return {
    deleted: deleteOutcome.settled,
    failed: deleteOutcome.failed,
    partial: deleteOutcome.partial,
    remainingKeys,
    legacyPayloadPresent,
  };
}
