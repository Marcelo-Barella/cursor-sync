import type { R2StorageCredentials } from "../app-r2-storage.js";
import { getR2Object, putR2Object } from "../app-r2-storage.js";
import { deriveObjectStorageKeyHex, decryptObjectPayload, encryptObjectPayload } from "./key-material.js";

export async function putEncryptedR2Object(
  credentials: R2StorageCredentials,
  dek: Buffer,
  userId: string,
  keyVersion: number,
  logicalSyncKey: string,
  plaintext: Buffer,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const envelope = encryptObjectPayload(dek, plaintext, userId, keyVersion, logicalSyncKey);
  const objectKey = deriveObjectStorageKeyHex(dek, logicalSyncKey);
  await putR2Object(credentials, objectKey, envelope, options);
}

export async function getEncryptedR2Object(
  credentials: R2StorageCredentials,
  dek: Buffer,
  userId: string,
  keyVersion: number,
  logicalSyncKey: string,
  options?: { signal?: AbortSignal }
): Promise<Buffer | undefined> {
  const objectKey = deriveObjectStorageKeyHex(dek, logicalSyncKey);
  const envelope = await getR2Object(credentials, objectKey, options);
  if (!envelope) {
    return undefined;
  }
  return decryptObjectPayload(dek, envelope, userId, keyVersion, logicalSyncKey);
}
