import * as vscode from "vscode";
import { getAppApiUrl } from "../config/urls.js";
import { getAppSession } from "../app-auth.js";
import { appApiAuthHeaders, readAppApiErrorJson } from "../app-api-http.js";
import type { AppConfigsPayloadV1 } from "../app-configs.js";
import { MANIFEST_SYNC_KEY } from "./constants.js";
import { envelopeFromBase64Wire, envelopeToBase64Wire, isValidCse1EnvelopeBytes } from "./envelope.js";
import { encryptObjectPayload, decryptObjectPayload } from "./key-material.js";
import type { E2eConfigsManifestPayload } from "./manifest-payload.js";
import { parseManifestPayload, serializeManifestPayload } from "./manifest-payload.js";

export interface ConfigsApiResponse {
  payload: AppConfigsPayloadV1 | Record<string, unknown> | null;
  manifestCiphertext: string | null;
  manifestVersion: number;
  updated_at: string;
}

export interface ConfigsPutBody {
  manifestCiphertext: string;
  expectedManifestVersion: number;
  clearLegacyPayload?: boolean;
}

function parseConfigsResponse(data: Record<string, unknown>): ConfigsApiResponse {
  const payload = (data.payload ?? null) as AppConfigsPayloadV1 | Record<string, unknown> | null;
  const manifestCiphertext =
    typeof data.manifestCiphertext === "string" ? data.manifestCiphertext : null;
  const manifestVersionRaw = data.manifestVersion;
  const manifestVersion =
    typeof manifestVersionRaw === "number" && Number.isInteger(manifestVersionRaw)
      ? manifestVersionRaw
      : 0;
  const updated_at =
    typeof data.updated_at === "string" ? data.updated_at : new Date().toISOString();
  return { payload, manifestCiphertext, manifestVersion, updated_at };
}

export async function fetchConfigsApi(
  context: vscode.ExtensionContext
): Promise<ConfigsApiResponse | undefined> {
  const session = await getAppSession(context);
  if (!session) {
    return undefined;
  }
  const base = getAppApiUrl().replace(/\/$/, "");
  const response = await fetch(`${base}/configs`, {
    method: "GET",
    headers: appApiAuthHeaders(session),
  });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    const body = await readAppApiErrorJson(response);
    throw new Error(body.error ?? `Failed to fetch configs (${response.status})`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return parseConfigsResponse(data);
}

export function assertWireManifestCiphertext(base64: string): Buffer {
  const raw = envelopeFromBase64Wire(base64);
  if (!isValidCse1EnvelopeBytes(raw)) {
    throw new Error("manifestCiphertext is not a valid CSE1 envelope.");
  }
  return raw;
}

export function encryptManifestPayload(
  dek: Buffer,
  userId: string,
  keyVersion: number,
  payload: E2eConfigsManifestPayload
): string {
  const plaintext = serializeManifestPayload(payload);
  const envelope = encryptObjectPayload(
    dek,
    plaintext,
    userId,
    keyVersion,
    MANIFEST_SYNC_KEY
  );
  return envelopeToBase64Wire(envelope);
}

export function decryptManifestPayload(
  dek: Buffer,
  userId: string,
  keyVersion: number,
  manifestCiphertextBase64: string
): E2eConfigsManifestPayload {
  const envelope = assertWireManifestCiphertext(manifestCiphertextBase64);
  const plaintext = decryptObjectPayload(dek, envelope, userId, keyVersion, MANIFEST_SYNC_KEY);
  return parseManifestPayload(plaintext);
}

export class ConfigsManifestConflictError extends Error {
  constructor() {
    super("MANIFEST_VERSION_MISMATCH");
    this.name = "ConfigsManifestConflictError";
  }
}

export async function putConfigsManifest(
  context: vscode.ExtensionContext,
  body: ConfigsPutBody
): Promise<ConfigsApiResponse> {
  const session = await getAppSession(context);
  if (!session) {
    throw new Error("App session required");
  }
  assertWireManifestCiphertext(body.manifestCiphertext);
  const base = getAppApiUrl().replace(/\/$/, "");
  const response = await fetch(`${base}/configs`, {
    method: "PUT",
    headers: {
      ...appApiAuthHeaders(session),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    const err = await readAppApiErrorJson(response);
    if (err.error === "MANIFEST_VERSION_MISMATCH") {
      throw new ConfigsManifestConflictError();
    }
  }
  if (!response.ok) {
    const err = await readAppApiErrorJson(response);
    throw new Error(err.error ?? `Failed to push configs (${response.status})`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  return parseConfigsResponse(data);
}

export async function putConfigsManifestWithRetry(
  context: vscode.ExtensionContext,
  buildBody: (expectedManifestVersion: number) => ConfigsPutBody,
  options?: { maxAttempts?: number }
): Promise<ConfigsApiResponse> {
  const maxAttempts = options?.maxAttempts ?? 3;
  let attempt = 0;
  const remote = await fetchConfigsApi(context);
  let expectedVersion = remote?.manifestVersion ?? 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await putConfigsManifest(context, buildBody(expectedVersion));
    } catch (err) {
      if (err instanceof ConfigsManifestConflictError) {
        const latest = await fetchConfigsApi(context);
        expectedVersion = latest?.manifestVersion ?? expectedVersion;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to update encrypted manifest after retries.");
}
