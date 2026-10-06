import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { argon2id } from "hash-wasm";
import {
  AAD_WRAP_PASS_PREFIX,
  AAD_WRAP_RECOVERY_PREFIX,
  DEK_BYTE_LENGTH,
  DEK_VERIFIER_MESSAGE,
  DEFAULT_ARGON2_PARAMS,
  GCM_NONCE_BYTE_LENGTH,
  HKDF_RECOVERY_INFO,
  HMAC_OBJECT_KEY_PREFIX,
  SALT_BYTE_LENGTH,
} from "./constants.js";
import { E2eCryptoError, encryptAes256Gcm, decryptAes256Gcm, packCse1Envelope } from "./envelope.js";
import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

export interface KdfParamsWire {
  m: number;
  t: number;
  p: number;
}

export interface KeyWrapBytes {
  nonce: Buffer;
  ct: Buffer;
}

export function generateDek(): Buffer {
  return nodeRandomBytes(DEK_BYTE_LENGTH);
}

export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTE_LENGTH);
}

export function computeDekVerifierHex(dek: Buffer): string {
  const hex = createHmac("sha256", dek).update(DEK_VERIFIER_MESSAGE).digest("hex");
  if (hex.length !== 64 || hex !== hex.toLowerCase()) {
    throw new E2eCryptoError("dekVerifier must be 64 lowercase hex chars.", "INVALID_ENVELOPE");
  }
  return hex;
}

export function assertDekVerifierHex(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new E2eCryptoError("dekVerifier must be lowercase hex (64 chars).", "INVALID_ENVELOPE");
  }
}

export async function deriveKekFromPassphrase(
  passphrase: string,
  salt: Buffer,
  kdfParams: KdfParamsWire
): Promise<Buffer> {
  if (salt.length < SALT_BYTE_LENGTH) {
    throw new E2eCryptoError("Salt must be at least 16 bytes.", "INVALID_ENVELOPE");
  }
  const memoryKiB = Math.floor(kdfParams.m / 1024);
  if (memoryKiB <= 0) {
    throw new E2eCryptoError("Invalid Argon2 memory parameter.", "INVALID_ENVELOPE");
  }
  const keyBytes = await argon2id({
    password: passphrase,
    salt,
    parallelism: kdfParams.p,
    iterations: kdfParams.t,
    memorySize: memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(keyBytes);
}

function wrapDekWithKey(
  wrappingKey: Buffer,
  dek: Buffer,
  aad: string,
  keyVersion: number
): KeyWrapBytes {
  const nonce = randomBytes(GCM_NONCE_BYTE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce,
    ct: Buffer.concat([ciphertext, tag]),
  };
}

function unwrapDekWithKey(
  wrappingKey: Buffer,
  wrap: KeyWrapBytes,
  aad: string
): Buffer {
  if (wrap.nonce.length !== GCM_NONCE_BYTE_LENGTH) {
    throw new E2eCryptoError("Wrap nonce must be 12 bytes.", "INVALID_ENVELOPE");
  }
  const tag = wrap.ct.subarray(wrap.ct.length - 16);
  const ciphertext = wrap.ct.subarray(0, wrap.ct.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, wrap.nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new E2eCryptoError("Wrong passphrase or recovery key.", "WRONG_PASSPHRASE");
  }
}

export function buildPassphraseWrapAad(userId: string, keyVersion: number): string {
  return `${AAD_WRAP_PASS_PREFIX}${userId}|${keyVersion}`;
}

export function buildRecoveryWrapAad(userId: string, keyVersion: number): string {
  return `${AAD_WRAP_RECOVERY_PREFIX}${userId}|${keyVersion}`;
}

export async function wrapDekForPassphrase(
  dek: Buffer,
  passphrase: string,
  userId: string,
  keyVersion: number,
  salt: Buffer,
  kdfParams: KdfParamsWire = DEFAULT_ARGON2_PARAMS
): Promise<{ salt: Buffer; kdfParams: KdfParamsWire; wrap: KeyWrapBytes }> {
  const kek = await deriveKekFromPassphrase(passphrase, salt, kdfParams);
  const aad = buildPassphraseWrapAad(userId, keyVersion);
  const wrap = wrapDekWithKey(kek, dek, aad, keyVersion);
  return { salt, kdfParams, wrap };
}

export function deriveRecoveryWrappingKey(recoveryKeyBytes: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", recoveryKeyBytes, "", HKDF_RECOVERY_INFO, 32));
}

export function wrapDekForRecovery(
  dek: Buffer,
  recoveryKeyBytes: Buffer,
  userId: string,
  keyVersion: number
): KeyWrapBytes {
  const rk = deriveRecoveryWrappingKey(recoveryKeyBytes);
  const aad = buildRecoveryWrapAad(userId, keyVersion);
  return wrapDekWithKey(rk, dek, aad, keyVersion);
}

export async function unwrapDekWithPassphrase(
  wrap: KeyWrapBytes,
  passphrase: string,
  userId: string,
  keyVersion: number,
  salt: Buffer,
  kdfParams: KdfParamsWire
): Promise<Buffer> {
  const kek = await deriveKekFromPassphrase(passphrase, salt, kdfParams);
  const aad = buildPassphraseWrapAad(userId, keyVersion);
  const dek = unwrapDekWithKey(kek, wrap, aad);
  if (dek.length !== DEK_BYTE_LENGTH) {
    throw new E2eCryptoError("Unwrapped DEK has invalid length.", "INVALID_ENVELOPE");
  }
  return dek;
}

export function unwrapDekWithRecoveryKey(
  wrap: KeyWrapBytes,
  recoveryKeyBytes: Buffer,
  userId: string,
  keyVersion: number
): Buffer {
  const rk = deriveRecoveryWrappingKey(recoveryKeyBytes);
  const aad = buildRecoveryWrapAad(userId, keyVersion);
  const dek = unwrapDekWithKey(rk, wrap, aad);
  if (dek.length !== DEK_BYTE_LENGTH) {
    throw new E2eCryptoError("Unwrapped DEK has invalid length.", "INVALID_ENVELOPE");
  }
  return dek;
}

export function deriveObjectStorageKeyHex(dek: Buffer, syncKey: string): string {
  return createHmac("sha256", dek)
    .update(`${HMAC_OBJECT_KEY_PREFIX}${syncKey}`)
    .digest("hex");
}

export function deriveGistFileNameHex(dek: Buffer, logicalName: string): string {
  return deriveObjectStorageKeyHex(dek, `gist:${logicalName}`);
}

export function encryptObjectPayload(
  dek: Buffer,
  plaintext: Buffer,
  userId: string,
  keyVersion: number,
  syncKey: string
): Buffer {
  const aad = `cursor-sync/obj/v1|${userId}|${keyVersion}|${syncKey}`;
  return encryptAes256Gcm(dek, plaintext, aad, keyVersion);
}

export function decryptObjectPayload(
  dek: Buffer,
  envelopeBytes: Buffer,
  userId: string,
  keyVersion: number,
  syncKey: string
): Buffer {
  const aad = `cursor-sync/obj/v1|${userId}|${keyVersion}|${syncKey}`;
  return decryptAes256Gcm(dek, envelopeBytes, aad);
}

export function wrapBytesToCse1(keyVersion: number, wrap: KeyWrapBytes): Buffer {
  return packCse1Envelope(keyVersion, wrap.nonce, wrap.ct);
}
