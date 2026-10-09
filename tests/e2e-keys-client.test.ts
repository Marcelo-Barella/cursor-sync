import { describe, expect, it } from "vitest";
import { parseKeyMaterialResponse } from "../src/e2e/keys-wire.js";

const NONCE_B64 = Buffer.alloc(12, 7).toString("base64");
const CT_B64 = Buffer.alloc(48, 3).toString("base64");
const SALT_B64 = Buffer.alloc(16, 1).toString("base64");

describe("e2e keys client wire parsing", () => {
  it("parses GET /v1/keys shape without dekVerifier", () => {
    const material = parseKeyMaterialResponse({
      keyVersion: 1,
      kdf: "argon2id",
      kdfParams: { m: 64 * 1024 * 1024, t: 3, p: 1 },
      salt: SALT_B64,
      passWrap: { nonce: NONCE_B64, ct: CT_B64 },
      recoveryWrap: { nonce: NONCE_B64, ct: CT_B64 },
    });
    expect(material.keyVersion).toBe(1);
    expect(material.passWrap.nonce.length).toBe(12);
    expect(material.recoveryWrap.ct.length).toBe(48);
  });
});
