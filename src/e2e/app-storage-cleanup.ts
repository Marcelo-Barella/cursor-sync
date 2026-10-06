import * as vscode from "vscode";
import { loadMigrationState } from "./migration.js";
import {
  runLegacyPlaintextCleanup,
  type LegacyPlaintextCleanupResult,
} from "./legacy-cleanup.js";
import { listPlaintextObjectKeys } from "./storage-plaintext.js";

const STRAY_CHECK_STATE_KEY = "cursorSync.e2e.lastStrayPlaintextCheck";
const STRAY_CHECK_INTERVAL_MS = 15 * 60 * 1000;

interface StrayCheckState {
  checkedAtMs: number;
  listingEmpty: boolean;
}

export type AppStorageCleanupResult =
  | { kind: "skipped"; reason: "throttled" | "nothing_to_do" }
  | { kind: "ran"; result: LegacyPlaintextCleanupResult };

async function loadStrayCheckState(
  context: vscode.ExtensionContext
): Promise<StrayCheckState | undefined> {
  return context.globalState.get<StrayCheckState>(STRAY_CHECK_STATE_KEY);
}

async function saveStrayCheckState(
  context: vscode.ExtensionContext,
  state: StrayCheckState
): Promise<void> {
  await context.globalState.update(STRAY_CHECK_STATE_KEY, state);
}

export async function runAppStorageLegacyCleanup(
  context: vscode.ExtensionContext,
  options?: {
    extraKeysFromConfigs?: string[];
    forceStrayCheck?: boolean;
  }
): Promise<AppStorageCleanupResult> {
  const migration = await loadMigrationState(context);
  const migrationComplete = migration?.phase === "completed";

  if (migrationComplete && !options?.forceStrayCheck) {
    const prior = await loadStrayCheckState(context);
    const freshEnough =
      prior &&
      prior.listingEmpty &&
      Date.now() - prior.checkedAtMs < STRAY_CHECK_INTERVAL_MS;
    if (freshEnough) {
      return { kind: "skipped", reason: "throttled" };
    }

    const keys = await listPlaintextObjectKeys(context);
    if (keys.length === 0) {
      await saveStrayCheckState(context, {
        checkedAtMs: Date.now(),
        listingEmpty: true,
      });
      return { kind: "skipped", reason: "nothing_to_do" };
    }
  }

  const result = await runLegacyPlaintextCleanup(context, {
    extraKeysFromConfigs: options?.extraKeysFromConfigs,
  });

  if (result.remainingKeys.length === 0) {
    await saveStrayCheckState(context, {
      checkedAtMs: Date.now(),
      listingEmpty: true,
    });
  } else {
    await saveStrayCheckState(context, {
      checkedAtMs: Date.now(),
      listingEmpty: false,
    });
  }

  return { kind: "ran", result };
}
