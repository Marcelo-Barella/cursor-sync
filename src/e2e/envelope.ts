import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { E2E_MAGIC, GCM_NONCE_BYTE_LENGTH, AAD_OBJECT_PREFIX } from "./constants.js";

export class E2eCryptoError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_ENVELOPE"
      | "DECRYPT_FAILED"
      | "WRONG_PASSPHRASE"
      | "INTEGRITY_FAILED"
  ) {
    super(message);
    this.name = "E2eCryptoError";
  }
}

const MIN_ENVELOPE_BYTES = E2E_MAGIC.length + 4 + GCM_NONCE_BYTE_LENGTH + 16;

export function isValidCse1EnvelopeBytes(buf: Buffer): boolean {
  if (buf.length < MIN_ENVELOPE_BYTES) {
    return false;
  }
  if (!buf.subarray(0, 4).equals(E2E_MAGIC)) {
    return false;
  }
  return true;
}

export function packCse1Envelope(
  keyVersion: number,
  nonce: Buffer,
  ciphertextWithTag: Buffer
): Buffer {
  if (keyVersion < 1 || !Number.isInteger(keyVersion)) {
    throw new E2eCryptoError("keyVersion must be a positive integer.", "INVALID_ENVELOPE");
  }
  if (nonce.length !== GCM_NONCE_BYTE_LENGTH) {
    throw new E2eCryptoError("Nonce must be 12 bytes.", "INVALID_ENVELOPE");
  }
  const header = Buffer.alloc(8);
  E2E_MAGIC.copy(header, 0);
  header.writeUInt32BE(keyVersion, 4);
  return Buffer.concat([header, nonce, ciphertextWithTag]);
}

export function unpackCse1Envelope(buf: Buffer): {
  keyVersion: number;
  nonce: Buffer;
  ciphertextWithTag: Buffer;
} {
  if (!isValidCse1EnvelopeBytes(buf)) {
    throw new E2eCryptoError("Invalid CSE1 envelope.", "INVALID_ENVELOPE");
  }
  const keyVersion = buf.readUInt32BE(4);
  const nonce = buf.subarray(8, 8 + GCM_NONCE_BYTE_LENGTH);
  const ciphertextWithTag = buf.subarray(8 + GCM_NONCE_BYTE_LENGTH);
  if (ciphertextWithTag.length < 16) {
    throw new E2eCryptoError("Ciphertext too short.", "INVALID_ENVELOPE");
  }
  return { keyVersion, nonce, ciphertextWithTag };
}

export function envelopeToBase64Wire(buf: Buffer): string {
  return buf.toString("base64");
}

export function envelopeFromBase64Wire(value: string): Buffer {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0) {
    throw new E2eCryptoError("Invalid base64 envelope.", "INVALID_ENVELOPE");
  }
  return buf;
}

export function encryptAes256Gcm(
  dek: Buffer,
  plaintext: Buffer,
  aad: string,
  keyVersion: number
): Buffer {
  const nonce = randomBytes(GCM_NONCE_BYTE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return packCse1Envelope(keyVersion, nonce, Buffer.concat([ciphertext, tag]));
}

export function decryptAes256Gcm(
  dek: Buffer,
  envelopeBytes: Buffer,
  aad: string,
  options?: { wrongPassphraseMessage?: string }
): Buffer {
  const { nonce, ciphertextWithTag } = unpackCse1Envelope(envelopeBytes);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    const msg =
      options?.wrongPassphraseMessage ??
      "Data failed integrity check. The file may be corrupted or encrypted with a different key.";
    throw new E2eCryptoError(msg, "INTEGRITY_FAILED");
  }
}

export function buildObjectAad(userId: string, keyVersion: number, syncKey: string): string {
  return `${AAD_OBJECT_PREFIX}${userId}|${keyVersion}|${syncKey}`;
}
