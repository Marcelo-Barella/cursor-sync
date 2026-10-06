import { describe, expect, it } from "vitest";
import {
  unwrapDekWithPassphraseMaterial,
  unwrapDekWithRecoveryMaterial,
} from "../src/e2e/unlock-crypto.js";
import type { ServerKeyMaterialResponse } from "../src/e2e/keys-wire.js";
import { wrapDekForPassphrase, wrapDekForRecovery } from "../src/e2e/key-material.js";
import { DEFAULT_ARGON2_PARAMS } from "../src/e2e/constants.js";
import { formatRecoveryKeyForDisplay, generateRecoveryKeyBytes } from "../src/e2e/recovery-key.js";

const USER = "user-test";

async function buildMaterial(
  dek: Buffer,
  passphrase: string,
  recoveryBytes: Buffer
): Promise<ServerKeyMaterialResponse> {
  const salt = Buffer.alloc(16, 1);
  const passWrap = await wrapDekForPassphrase(
    dek,
    passphrase,
    USER,
    1,
    salt,
    { ...DEFAULT_ARGON2_PARAMS }
  );
  const recoveryWrap = wrapDekForRecovery(dek, recoveryBytes, USER, 1);
  return {
    keyVersion: 1,
    kdf: "argon2id",
    kdfParams: passWrap.kdfParams,
    salt: passWrap.salt,
    passWrap: passWrap.wrap,
    recoveryWrap,
  };
}

describe("unlock fresh server key material", () => {
  it("rejects old passphrase after server salt/wrap rotation", async () => {
    const dek = Buffer.alloc(32, 9);
    const oldMat = await buildMaterial(dek, "old-passphrase-ok", generateRecoveryKeyBytes());
    const newMat = await buildMaterial(dek, "new-passphrase-ok", generateRecoveryKeyBytes());

    await expect(
      unwrapDekWithPassphraseMaterial(oldMat, "new-passphrase-ok", USER)
    ).rejects.toThrow();
    const unlocked = await unwrapDekWithPassphraseMaterial(newMat, "new-passphrase-ok", USER);
    expect(unlocked.equals(dek)).toBe(true);
  });

  it("rejects old recovery key after rotation", async () => {
    const dek = Buffer.alloc(32, 4);
    const oldRecovery = generateRecoveryKeyBytes();
    const newRecovery = generateRecoveryKeyBytes();
    const oldMat = await buildMaterial(dek, "passphrase-ok-12", oldRecovery);
    const newMat = await buildMaterial(dek, "passphrase-ok-12", newRecovery);

    const oldFormatted = formatRecoveryKeyForDisplay(oldRecovery);
    expect(() => unwrapDekWithRecoveryMaterial(newMat, oldFormatted, USER)).toThrow();
    const newFormatted = formatRecoveryKeyForDisplay(newRecovery);
    const unlocked = unwrapDekWithRecoveryMaterial(newMat, newFormatted, USER);
    expect(unlocked.equals(dek)).toBe(true);
  });
});
