import * as vscode from "vscode";
import type { AppConfigsPayloadV1 } from "../app-configs.js";
import { fetchConfigsApi } from "./configs-sync.js";
import { deletePlaintextR2Objects } from "./storage-plaintext.js";
import { loadMigrationState, saveMigrationState } from "./migration.js";
import { getLogger } from "../diagnostics.js";

function isAppConfigsPayloadV1(value: unknown): value is AppConfigsPayloadV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as AppConfigsPayloadV1;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}

export function legacyPlaintextSyncKeysFromPayload(payload: AppConfigsPayloadV1): string[] {
  return Object.keys(payload.files).sort();
}

export async function listRemoteLegacyPlaintextKeys(
  context: vscode.ExtensionContext
): Promise<string[]> {
  const remote = await fetchConfigsApi(context);
  if (!remote?.payload || !isAppConfigsPayloadV1(remote.payload)) {
    return [];
  }
  return legacyPlaintextSyncKeysFromPayload(remote.payload);
}

export async function runLegacyPlaintextCleanup(
  context: vscode.ExtensionContext,
  options?: { throwOnDeleteFailure?: boolean }
): Promise<{ deleted: string[]; legacyPayloadPresent: boolean }> {
  const logger = getLogger();
  const remote = await fetchConfigsApi(context);
  const legacyPayloadPresent = Boolean(
    remote?.payload && isAppConfigsPayloadV1(remote.payload)
  );
  const legacyKeys = legacyPayloadPresent
    ? legacyPlaintextSyncKeysFromPayload(remote!.payload as AppConfigsPayloadV1)
    : [];

  const migration = await loadMigrationState(context);
  const completed = new Set(migration?.completedPlaintextR2Keys ?? []);
  const pending = legacyKeys.filter((k) => !completed.has(k));

  let deleted: string[] = [];
  if (pending.length > 0) {
    deleted = await deletePlaintextR2Objects(context, pending);
    for (const key of deleted) {
      completed.add(key);
    }
    const failed = pending.filter((k) => !deleted.includes(k));
    if (failed.length > 0) {
      const message = `Plaintext cleanup incomplete for ${failed.length} object(s). Will retry on next sync.`;
      logger.appendLine(`[${new Date().toISOString()}] ${message}`);
      if (options?.throwOnDeleteFailure) {
        throw new Error(message);
      }
    }
  }

  if (migration) {
    await saveMigrationState(context, {
      phase: migration.phase,
      completedPlaintextR2Keys: [...completed],
      completedPlaintextGistFiles: migration.completedPlaintextGistFiles,
      legacyPayloadCleared: !legacyPayloadPresent,
    });
  }

  return { deleted, legacyPayloadPresent };
}
