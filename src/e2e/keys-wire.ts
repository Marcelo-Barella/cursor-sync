import { assertDekVerifierHex, type KdfParamsWire, type KeyWrapBytes } from "./key-material.js";

export class KeysWireParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysWireParseError";
  }
}

export interface KeyWrapWire {
  nonce: string;
  ct: string;
}

export interface ServerKeyMaterialResponse {
  keyVersion: number;
  kdf: "argon2id";
  kdfParams: KdfParamsWire;
  salt: Buffer;
  passWrap: KeyWrapBytes;
  recoveryWrap: KeyWrapBytes;
}

function fromB64(value: string, label: string): Buffer {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0) {
    throw new KeysWireParseError(`Invalid base64 for ${label}`);
  }
  return buf;
}

function parseWrap(wrap: KeyWrapWire, label: string): KeyWrapBytes {
  if (!wrap?.nonce || !wrap?.ct) {
    throw new KeysWireParseError(`Missing ${label}`);
  }
  const nonce = fromB64(wrap.nonce, `${label}.nonce`);
  const ct = fromB64(wrap.ct, `${label}.ct`);
  if (nonce.length !== 12) {
    throw new KeysWireParseError(`${label}.nonce must be 12 bytes`);
  }
  return { nonce, ct };
}

export function parseKeyMaterialResponse(data: Record<string, unknown>): ServerKeyMaterialResponse {
  const keyVersion = data.keyVersion;
  if (typeof keyVersion !== "number" || !Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new KeysWireParseError("Invalid keyVersion");
  }
  if (data.kdf !== "argon2id") {
    throw new KeysWireParseError("Invalid kdf");
  }
  const kdfParams = data.kdfParams as KdfParamsWire | undefined;
  if (
    !kdfParams ||
    typeof kdfParams.m !== "number" ||
    typeof kdfParams.t !== "number" ||
    typeof kdfParams.p !== "number"
  ) {
    throw new KeysWireParseError("Invalid kdfParams");
  }
  const saltRaw = data.salt;
  if (typeof saltRaw !== "string") {
    throw new KeysWireParseError("Invalid salt");
  }
  const salt = fromB64(saltRaw, "salt");
  if (salt.length < 16) {
    throw new KeysWireParseError("Salt must be at least 16 bytes");
  }
  const passWrap = parseWrap(data.passWrap as KeyWrapWire, "passWrap");
  const recoveryWrap = parseWrap(data.recoveryWrap as KeyWrapWire, "recoveryWrap");
  return {
    keyVersion,
    kdf: "argon2id",
    kdfParams,
    salt,
    passWrap,
    recoveryWrap,
  };
}

export function assertPutKeysBodyDekVerifier(dekVerifier: string): void {
  assertDekVerifierHex(dekVerifier);
}
