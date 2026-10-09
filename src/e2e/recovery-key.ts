import { randomBytes } from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRecoveryKeyBytes(): Buffer {
  return randomBytes(32);
}

function encodeCrockfordBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const index = (value >> bits) & 31;
      output += CROCKFORD_ALPHABET[index];
    }
  }
  if (bits > 0) {
    const index = (value << (5 - bits)) & 31;
    output += CROCKFORD_ALPHABET[index];
  }
  return output;
}

function normalizeRecoveryKeyInput(input: string): string {
  return input
    .replace(/[-\s]/g, "")
    .toUpperCase()
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0");
}

function decodeCrockfordBase32(input: string): Buffer {
  const normalized = normalizeRecoveryKeyInput(input);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const index = CROCKFORD_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid recovery key character.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return Buffer.from(out);
}

export function formatRecoveryKeyForDisplay(recoveryKeyBytes: Buffer): string {
  const encoded = encodeCrockfordBase32(recoveryKeyBytes);
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += 4) {
    groups.push(encoded.slice(i, i + 4));
  }
  return groups.join("-");
}

export function lastRecoveryKeyGroup(formatted: string): string {
  const groups = formatted.split("-").filter((g) => g.length > 0);
  return groups[groups.length - 1] ?? "";
}

export function parseRecoveryKeyInput(input: string): Buffer {
  const bytes = decodeCrockfordBase32(input);
  if (bytes.length < 32) {
    throw new Error("Recovery key is too short.");
  }
  return bytes.subarray(0, 32);
}
