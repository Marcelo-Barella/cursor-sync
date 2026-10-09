import {
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
} from "./key-material.js";
import type { ServerKeyMaterialResponse } from "./keys-wire.js";
import { parseRecoveryKeyInput } from "./recovery-key.js";

export async function unwrapDekWithPassphraseMaterial(
  material: ServerKeyMaterialResponse,
  passphrase: string,
  userId: string
): Promise<Buffer> {
  return unwrapDekWithPassphrase(
    material.passWrap,
    passphrase,
    userId,
    material.keyVersion,
    material.salt,
    material.kdfParams
  );
}

export function unwrapDekWithRecoveryMaterial(
  material: ServerKeyMaterialResponse,
  recoveryInput: string,
  userId: string
): Buffer {
  const bytes = parseRecoveryKeyInput(recoveryInput);
  return unwrapDekWithRecoveryKey(
    material.recoveryWrap,
    bytes,
    userId,
    material.keyVersion
  );
}

export function dekMatches(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}
