import type * as vscode from "vscode";
import { getR2Object, putR2Object } from "./app-r2-storage.js";
import { computeChecksum } from "./packaging.js";
import type { ManifestFileEntry } from "./types.js";
import type { AppConfigsPayloadV1 } from "./app-configs.js";
import {
  clearAppConfigRemoteDirty,
  markAppConfigRemoteDirty,
  readAppConfigRemoteDirty,
} from "./app-config-remote-state.js";
import type { R2StorageCredentials } from "./app-r2-storage.js";

export async function listManifestObjectMismatches(
  credentials: R2StorageCredentials,
  manifestFiles: Record<string, ManifestFileEntry>,
  keys: string[],
  options?: { signal?: AbortSignal }
): Promise<string[]> {
  const mismatches: string[] = [];
  for (const syncKey of keys) {
    const entry = manifestFiles[syncKey];
    if (!entry) {
      continue;
    }
    const object = await getR2Object(credentials, syncKey, { signal: options?.signal });
    if (!object || computeChecksum(object) !== entry.checksum) {
      mismatches.push(syncKey);
    }
  }
  return mismatches;
}

export async function verifyPayloadObjectsMatchManifest(
  credentials: R2StorageCredentials,
  payload: AppConfigsPayloadV1,
  options?: { signal?: AbortSignal }
): Promise<string[]> {
  const keys = Object.keys(payload.manifest.files);
  return listManifestObjectMismatches(credentials, payload.manifest.files, keys, options);
}

export async function tryClearRemoteDirtyWhenReconciled(
  context: vscode.ExtensionContext,
  credentials: R2StorageCredentials,
  payload: AppConfigsPayloadV1,
  options?: { signal?: AbortSignal }
): Promise<boolean> {
  const mismatches = await verifyPayloadObjectsMatchManifest(credentials, payload, options);
  if (mismatches.length === 0) {
    await clearAppConfigRemoteDirty(context);
    return true;
  }
  await markAppConfigRemoteDirty(context, "object_manifest_mismatch", mismatches);
  return false;
}

export async function reconcileRemoteDirtyOnPush(
  context: vscode.ExtensionContext,
  credentials: R2StorageCredentials,
  remote: AppConfigsPayloadV1,
  local: AppConfigsPayloadV1,
  options?: { signal?: AbortSignal }
): Promise<number> {
  const dirty = readAppConfigRemoteDirty(context);
  if (!dirty) {
    return 0;
  }
  const keys = Object.keys(remote.manifest.files);
  const mismatches = await listManifestObjectMismatches(
    credentials,
    remote.manifest.files,
    keys,
    options
  );
  let repaired = 0;
  for (const syncKey of mismatches) {
    const file = local.files[syncKey];
    const manifestEntry = local.manifest.files[syncKey];
    if (!file?.content || !manifestEntry) {
      continue;
    }
    const encoding =
      manifestEntry.encoding === "base64" || file.encoding === "base64"
        ? "base64"
        : "utf-8";
    const body =
      encoding === "base64"
        ? Buffer.from(file.content, "base64")
        : Buffer.from(file.content, "utf-8");
    await putR2Object(credentials, syncKey, body);
    repaired += 1;
  }
  if (repaired > 0) {
    const after = await verifyPayloadObjectsMatchManifest(credentials, remote, options);
    if (after.length === 0) {
      await clearAppConfigRemoteDirty(context);
    }
  }
  return repaired;
}
