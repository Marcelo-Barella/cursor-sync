import type { R2StorageCredentials } from "../app-r2-storage.js";
import { getR2Object, putR2Object } from "../app-r2-storage.js";
import { deriveObjectStorageKeyHex, decryptObjectPayload, encryptObjectPayload } from "./key-material.js";

export async function putEncryptedR2Object(
  credentials: R2StorageCredentials,
  dek: Buffer,
  userId: string,
  keyVersion: number,
  logicalSyncKey: string,
  plaintext: Buffer
): Promise<void> {
  const envelope = encryptObjectPayload(dek, plaintext, userId, keyVersion, logicalSyncKey);
  const objectKey = deriveObjectStorageKeyHex(dek, logicalSyncKey);
  await putR2Object(credentials, objectKey, envelope);
}

export async function getEncryptedR2Object(
  credentials: R2StorageCredentials,
  dek: Buffer,
  userId: string,
  keyVersion: number,
  logicalSyncKey: string
): Promise<Buffer | undefined> {
  const objectKey = deriveObjectStorageKeyHex(dek, logicalSyncKey);
  const envelope = await getR2Object(credentials, objectKey);
  if (!envelope) {
    return undefined;
  }
  return decryptObjectPayload(dek, envelope, userId, keyVersion, logicalSyncKey);
}
