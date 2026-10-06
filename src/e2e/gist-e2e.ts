import { GIST_E2E_FORMAT, GIST_E2E_MARKER_FILE } from "./constants.js";
import { envelopeToBase64Wire, envelopeFromBase64Wire } from "./envelope.js";
import { deriveGistFileNameHex, encryptObjectPayload, decryptObjectPayload } from "./key-material.js";

export function buildGistMarkerJson(keyVersion: number): string {
  return JSON.stringify({ format: GIST_E2E_FORMAT, keyVersion }, null, 2);
}

export function isGistE2eMarkerFileName(fileName: string): boolean {
  return fileName === GIST_E2E_MARKER_FILE;
}

export function encryptGistFileContent(
  dek: Buffer,
  plaintextUtf8: string,
  userId: string,
  keyVersion: number,
  logicalFileName: string
): { gistFileName: string; content: string } {
  const syncKey = `gist:${logicalFileName}`;
  const envelope = encryptObjectPayload(
    dek,
    Buffer.from(plaintextUtf8, "utf8"),
    userId,
    keyVersion,
    syncKey
  );
  return {
    gistFileName: deriveGistFileNameHex(dek, logicalFileName),
    content: envelopeToBase64Wire(envelope),
  };
}

export function decryptGistFileContent(
  dek: Buffer,
  base64Envelope: string,
  userId: string,
  keyVersion: number,
  logicalFileName: string
): string {
  const bytes = envelopeFromBase64Wire(base64Envelope);
  const syncKey = `gist:${logicalFileName}`;
  const plain = decryptObjectPayload(dek, bytes, userId, keyVersion, syncKey);
  return plain.toString("utf8");
}
