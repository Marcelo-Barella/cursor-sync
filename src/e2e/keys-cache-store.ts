import * as vscode from "vscode";
import type { KeysGateCache, KeysVerificationState } from "./keys-client.js";
import {
  parseKeyMaterialResponse,
  serializeKeyMaterialToWire,
  type ServerKeyMaterialResponse,
} from "./keys-wire.js";

const PERSISTED_KEYS_CACHE_KEY = "cursorSync.e2e.keysCache.v1";

interface PersistedKeysCacheWire {
  presence: KeysGateCache["presence"];
  verification: KeysVerificationState;
  fetchedAtMs?: number;
  keyMaterialWire?: Record<string, unknown>;
}

export async function loadPersistedKeysCache(
  context: vscode.ExtensionContext
): Promise<KeysGateCache | undefined> {
  const raw = context.globalState.get<PersistedKeysCacheWire>(PERSISTED_KEYS_CACHE_KEY);
  if (!raw || raw.presence === "unknown") {
    return undefined;
  }
  let keyMaterial: ServerKeyMaterialResponse | undefined;
  if (raw.keyMaterialWire) {
    try {
      keyMaterial = parseKeyMaterialResponse(raw.keyMaterialWire);
    } catch {
      return undefined;
    }
  }
  return {
    presence: raw.presence,
    verification: raw.verification ?? "unknown",
    keyMaterial,
    fetchedAtMs: raw.fetchedAtMs,
  };
}

export async function persistKeysCache(
  context: vscode.ExtensionContext,
  cache: KeysGateCache
): Promise<void> {
  if (cache.presence === "unknown") {
    await context.globalState.update(PERSISTED_KEYS_CACHE_KEY, undefined);
    return;
  }
  const wire: PersistedKeysCacheWire = {
    presence: cache.presence,
    verification: cache.verification,
    fetchedAtMs: cache.fetchedAtMs,
  };
  if (cache.keyMaterial) {
    wire.keyMaterialWire = serializeKeyMaterialToWire(cache.keyMaterial);
  }
  await context.globalState.update(PERSISTED_KEYS_CACHE_KEY, wire);
}

export async function clearPersistedKeysCache(
  context?: vscode.ExtensionContext
): Promise<void> {
  if (!context?.globalState?.update) {
    return;
  }
  await context.globalState.update(PERSISTED_KEYS_CACHE_KEY, undefined);
}
