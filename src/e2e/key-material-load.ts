import * as vscode from "vscode";
import {
  fetchServerKeyMaterial,
  getCachedKeysGate,
  hydrateKeysCacheFromDisk,
  KeysApiError,
} from "./keys-client.js";
import type { ServerKeyMaterialResponse } from "./keys-wire.js";

function keysApiUserMessage(err: unknown): string {
  if (err instanceof KeysApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function canFallbackToCachedKeyMaterial(err: unknown): boolean {
  if (err instanceof KeysApiError) {
    return err.status === 429;
  }
  if (err instanceof TypeError) {
    return true;
  }
  return false;
}

export type KeyMaterialLoadResult =
  | {
      ok: true;
      material: ServerKeyMaterialResponse;
      usedCacheFallback: boolean;
      fallbackNotice?: string;
    }
  | { ok: false; message: string };

export async function loadKeyMaterialForCryptoOps(
  context: vscode.ExtensionContext
): Promise<KeyMaterialLoadResult> {
  try {
    const cache = await fetchServerKeyMaterial(context, { force: true });
    if (!cache.keyMaterial) {
      return { ok: false, message: "Could not load encryption keys from the server." };
    }
    return { ok: true, material: cache.keyMaterial, usedCacheFallback: false };
  } catch (err) {
    if (!canFallbackToCachedKeyMaterial(err)) {
      return { ok: false, message: keysApiUserMessage(err) };
    }
    await hydrateKeysCacheFromDisk(context);
    const disk = getCachedKeysGate();
    if (!disk.keyMaterial) {
      return { ok: false, message: keysApiUserMessage(err) };
    }
    const base = keysApiUserMessage(err);
    return {
      ok: true,
      material: disk.keyMaterial,
      usedCacheFallback: true,
      fallbackNotice: `${base} Using the last key metadata stored on this device.`,
    };
  }
}
