import * as vscode from "vscode";
import { getAppApiUrl, InvalidAppApiUrlError } from "../config/urls.js";
import { getAppSession } from "../app-auth.js";
import { appApiAuthHeaders, readAppApiErrorJson } from "../app-api-http.js";
import { rateLimitMessageFromResponse } from "./rate-limit.js";
import { KEYS_GET_TIMEOUT_MS } from "./network-errors.js";
import { assertDekVerifierHex, type KdfParamsWire, type KeyWrapBytes } from "./key-material.js";
import {
  parseKeyMaterialResponse,
  type KeyWrapWire,
  type ServerKeyMaterialResponse,
} from "./keys-wire.js";
import {
  clearPersistedKeysCache,
  loadPersistedKeysCache,
  persistKeysCache,
} from "./keys-cache-store.js";

export class KeysApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "KeysApiError";
  }
}

export interface PutKeysBody {
  keyVersion: 1;
  kdf: "argon2id";
  kdfParams: KdfParamsWire;
  salt: string;
  passWrap: KeyWrapWire;
  recoveryWrap: KeyWrapWire;
  dekVerifier: string;
}

export interface RewrapPassphraseBody {
  keyVersion: number;
  dekVerifier: string;
  kdfParams: KdfParamsWire;
  salt: string;
  passWrap: KeyWrapWire;
}

export interface RotateRecoveryBody {
  keyVersion: number;
  dekVerifier: string;
  recoveryWrap: KeyWrapWire;
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

export type KeysPresence = "unknown" | "not_set" | "set";

export type KeysVerificationState =
  | "unknown"
  | "verified"
  | "email_not_verified"
  | "unverified_offline";

export interface KeysGateCache {
  presence: KeysPresence;
  verification: KeysVerificationState;
  keyMaterial?: ServerKeyMaterialResponse;
  fetchedAtMs?: number;
}

let inMemoryKeysCache: KeysGateCache = { presence: "unknown", verification: "unknown" };

export const KEYS_CACHE_STALE_MS = 5 * 60 * 1000;

export function keysCacheNeedsRefresh(cache: KeysGateCache): boolean {
  if (cache.presence === "unknown" || cache.verification === "unverified_offline") {
    return true;
  }
  if (cache.verification !== "verified") {
    return true;
  }
  if (!cache.fetchedAtMs) {
    return true;
  }
  return Date.now() - cache.fetchedAtMs > KEYS_CACHE_STALE_MS;
}

export function getCachedKeysGate(): KeysGateCache {
  return inMemoryKeysCache;
}

export function hasVerifiedKeysCacheForOfflineUnlock(cache: KeysGateCache): boolean {
  return (
    cache.presence === "set" &&
    (cache.verification === "verified" || cache.verification === "unverified_offline") &&
    cache.keyMaterial !== undefined
  );
}

export async function hydrateKeysCacheFromDisk(
  context: vscode.ExtensionContext
): Promise<KeysGateCache> {
  if (inMemoryKeysCache.presence !== "unknown") {
    return inMemoryKeysCache;
  }
  const persisted = await loadPersistedKeysCache(context);
  if (persisted) {
    inMemoryKeysCache = persisted;
  }
  return inMemoryKeysCache;
}

export async function setCachedKeysGate(
  context: vscode.ExtensionContext,
  cache: KeysGateCache
): Promise<void> {
  inMemoryKeysCache = cache;
  await persistKeysCache(context, cache);
}

export async function invalidateKeysGateCache(
  context?: vscode.ExtensionContext
): Promise<void> {
  inMemoryKeysCache = { presence: "unknown", verification: "unknown" };
  if (context) {
    await clearPersistedKeysCache(context);
  }
}

export async function markKeysCacheUnverifiedOffline(
  context: vscode.ExtensionContext
): Promise<void> {
  await hydrateKeysCacheFromDisk(context);
  const cache = inMemoryKeysCache;
  if (cache.presence === "unknown") {
    return;
  }
  await setCachedKeysGate(context, {
    ...cache,
    verification: "unverified_offline",
  });
}

async function authFetch(
  context: vscode.ExtensionContext,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const session = await getAppSession(context);
  if (!session) {
    throw new KeysApiError("App session required", 401);
  }
  let base: string;
  try {
    base = getAppApiUrl().replace(/\/$/, "");
  } catch (err) {
    if (err instanceof InvalidAppApiUrlError) {
      throw new KeysApiError(err.message, 0, "INVALID_API_URL");
    }
    throw err;
  }
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...appApiAuthHeaders(session),
      ...(init?.headers ?? {}),
    },
  });
}

export type FetchServerKeyMaterialResult = {
  cache: KeysGateCache;
  fetchedFromNetwork: boolean;
};

export async function fetchServerKeyMaterial(
  context: vscode.ExtensionContext,
  options?: { force?: boolean; skipNetwork?: boolean }
): Promise<FetchServerKeyMaterialResult> {
  await hydrateKeysCacheFromDisk(context);
  const stale = keysCacheNeedsRefresh(inMemoryKeysCache);
  if (
    !options?.force &&
    !stale &&
    inMemoryKeysCache.presence !== "unknown"
  ) {
    return { cache: inMemoryKeysCache, fetchedFromNetwork: false };
  }
  if (options?.skipNetwork) {
    return { cache: inMemoryKeysCache, fetchedFromNetwork: false };
  }

  const response = await authFetch(context, "/v1/keys", {
    method: "GET",
    signal: AbortSignal.timeout(KEYS_GET_TIMEOUT_MS),
  });
  const cache = await keysGetResponseToCache(response);
  await setCachedKeysGate(context, cache);
  return { cache, fetchedFromNetwork: true };
}

export async function keysGetResponseToCache(response: Response): Promise<KeysGateCache> {
  if (response.status === 404) {
    const body = await readAppApiErrorJson(response);
    if (body.error && body.error !== "KEYS_NOT_SET") {
      throw new KeysApiError(body.error, 404, body.error);
    }
    return {
      presence: "not_set",
      verification: "verified",
      fetchedAtMs: Date.now(),
    };
  }
  if (response.status === 429) {
    const body = await readAppApiErrorJson(response);
    throw new KeysApiError(
      rateLimitMessageFromResponse(response, body.error ?? "RATE_LIMITED"),
      429,
      body.error ?? "RATE_LIMITED"
    );
  }
  if (response.status === 403) {
    const body = await readAppApiErrorJson(response);
    if (body.error === "EMAIL_NOT_VERIFIED") {
      return {
        presence: "not_set",
        verification: "email_not_verified",
        fetchedAtMs: Date.now(),
      };
    }
    throw new KeysApiError(body.error ?? "Forbidden", 403, body.error);
  }
  if (response.status === 401) {
    throw new KeysApiError("Log in to Cursor Sync again to continue.", 401, "UNAUTHORIZED");
  }
  if (response.status === 503) {
    const body = await readAppApiErrorJson(response);
    throw new KeysApiError(
      "Cursor Sync API is temporarily unavailable. Try again later.",
      503,
      body.error ?? "SERVICE_UNAVAILABLE"
    );
  }
  if (!response.ok) {
    const body = await readAppApiErrorJson(response);
    const message =
      response.status >= 500
        ? "Cursor Sync API is temporarily unavailable. Try again later."
        : (body.error ?? `GET /v1/keys failed (${response.status})`);
    throw new KeysApiError(message, response.status, body.error);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const keyMaterial = parseKeyMaterialResponse(data);
  return {
    presence: "set",
    verification: "verified",
    keyMaterial,
    fetchedAtMs: Date.now(),
  };
}

export async function putServerKeyMaterial(
  context: vscode.ExtensionContext,
  body: PutKeysBody
): Promise<ServerKeyMaterialResponse> {
  assertDekVerifierHex(body.dekVerifier);
  const response = await authFetch(context, "/v1/keys", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
    message?: string;
  };
  if (response.status === 409 && data.error === "KEYS_ALREADY_SET") {
    throw new KeysApiError("Encryption keys already exist on the server.", 409, "KEYS_ALREADY_SET");
  }
  if (response.status === 400 && data.error === "INVALID_PAYLOAD") {
    throw new KeysApiError(data.message ?? "Invalid key setup payload.", 400, "INVALID_PAYLOAD");
  }
  if (response.status !== 201) {
    throw new KeysApiError(
      data.error ?? `PUT /v1/keys failed (${response.status})`,
      response.status,
      data.error
    );
  }
  const material = parseKeyMaterialResponse(data);
  await setCachedKeysGate(context, {
    presence: "set",
    verification: "verified",
    keyMaterial: material,
    fetchedAtMs: Date.now(),
  });
  return material;
}

export async function rewrapPassphraseOnServer(
  context: vscode.ExtensionContext,
  body: RewrapPassphraseBody
): Promise<ServerKeyMaterialResponse> {
  assertDekVerifierHex(body.dekVerifier);
  const response = await authFetch(context, "/v1/keys/rewrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (response.status === 403 && data.error === "DEK_VERIFIER_MISMATCH") {
    throw new KeysApiError("Passphrase change rejected (verifier mismatch).", 403, "DEK_VERIFIER_MISMATCH");
  }
  if (response.status === 409 && data.error === "KEY_VERSION_MISMATCH") {
    throw new KeysApiError("Key version mismatch.", 409, "KEY_VERSION_MISMATCH");
  }
  if (!response.ok) {
    throw new KeysApiError(
      data.error ?? `POST /v1/keys/rewrap failed (${response.status})`,
      response.status,
      data.error
    );
  }
  const material = parseKeyMaterialResponse(data);
  await setCachedKeysGate(context, {
    presence: "set",
    verification: "verified",
    keyMaterial: material,
    fetchedAtMs: Date.now(),
  });
  return material;
}

export async function rotateRecoveryOnServer(
  context: vscode.ExtensionContext,
  body: RotateRecoveryBody
): Promise<ServerKeyMaterialResponse> {
  assertDekVerifierHex(body.dekVerifier);
  const response = await authFetch(context, "/v1/keys/recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string;
  };
  if (response.status === 403 && data.error === "DEK_VERIFIER_MISMATCH") {
    throw new KeysApiError("Recovery rotation rejected (verifier mismatch).", 403, "DEK_VERIFIER_MISMATCH");
  }
  if (response.status === 409 && data.error === "KEY_VERSION_MISMATCH") {
    throw new KeysApiError("Key version mismatch.", 409, "KEY_VERSION_MISMATCH");
  }
  if (!response.ok) {
    throw new KeysApiError(
      data.error ?? `POST /v1/keys/recovery failed (${response.status})`,
      response.status,
      data.error
    );
  }
  const material = parseKeyMaterialResponse(data);
  await setCachedKeysGate(context, {
    presence: "set",
    verification: "verified",
    keyMaterial: material,
    fetchedAtMs: Date.now(),
  });
  return material;
}

export function buildPutKeysBody(
  keyVersion: 1,
  salt: Buffer,
  kdfParams: KdfParamsWire,
  passWrap: KeyWrapBytes,
  recoveryWrap: KeyWrapBytes,
  dekVerifier: string
): PutKeysBody {
  return {
    keyVersion,
    kdf: "argon2id",
    kdfParams,
    salt: b64(salt),
    passWrap: { nonce: b64(passWrap.nonce), ct: b64(passWrap.ct) },
    recoveryWrap: { nonce: b64(recoveryWrap.nonce), ct: b64(recoveryWrap.ct) },
    dekVerifier,
  };
}
