import * as vscode from "vscode";
import {
  fetchServerKeyMaterial,
  getCachedKeysGate,
  hydrateKeysCacheFromDisk,
  KeysApiError,
  markKeysCacheUnverifiedOffline,
} from "./keys-client.js";
import type { ServerKeyMaterialResponse } from "./keys-wire.js";
import { isTransientNetworkError } from "./network-errors.js";

function keysApiUserMessage(err: unknown): string {
  if (err instanceof KeysApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const OFFLINE_KEY_MATERIAL_MESSAGE =
  "Could not reach the Cursor Sync API. Connect to the internet and try again.";

export const OFFLINE_UNLOCK_SUCCESS_LABEL = "Unlocked offline using cached keys";

export type KeyMaterialLoadOptions = {
  allowOfflineFallback?: boolean;
  prefetched?: {
    material: ServerKeyMaterialResponse;
    usedCacheFallback: boolean;
  };
};

export type KeyMaterialLoadResult =
  | {
      ok: true;
      material: ServerKeyMaterialResponse;
      usedCacheFallback: boolean;
    }
  | { ok: false; message: string };

export async function loadKeyMaterialForCryptoOps(
  context: vscode.ExtensionContext,
  options?: KeyMaterialLoadOptions
): Promise<KeyMaterialLoadResult> {
  const allowOfflineFallback = options?.allowOfflineFallback === true;
  if (options?.prefetched) {
    if (options.prefetched.usedCacheFallback) {
      await markKeysCacheUnverifiedOffline(context);
    }
    return {
      ok: true,
      material: options.prefetched.material,
      usedCacheFallback: options.prefetched.usedCacheFallback,
    };
  }
  try {
    const { cache } = await fetchServerKeyMaterial(context, { force: true });
    if (!cache.keyMaterial) {
      return { ok: false, message: "Could not load encryption keys from the server." };
    }
    return { ok: true, material: cache.keyMaterial, usedCacheFallback: false };
  } catch (err) {
    if (err instanceof KeysApiError && err.status === 429) {
      return { ok: false, message: keysApiUserMessage(err) };
    }
    if (!isTransientNetworkError(err)) {
      return { ok: false, message: keysApiUserMessage(err) };
    }
    if (!allowOfflineFallback) {
      return { ok: false, message: OFFLINE_KEY_MATERIAL_MESSAGE };
    }
    await hydrateKeysCacheFromDisk(context);
    const disk = getCachedKeysGate();
    if (!disk.keyMaterial) {
      return { ok: false, message: OFFLINE_KEY_MATERIAL_MESSAGE };
    }
    await markKeysCacheUnverifiedOffline(context);
    return {
      ok: true,
      material: disk.keyMaterial,
      usedCacheFallback: true,
    };
  }
}
