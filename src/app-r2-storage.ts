import { AwsClient } from "aws4fetch";
import * as vscode from "vscode";
import { getAppApiUrl, getAppSession } from "./app-auth.js";

export interface R2StorageCredentials {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: string;
}

const LOGIN_REQUIRED_MESSAGE = "Log in to Cursor Sync to sync configs with the app.";
const EXPIRY_BUFFER_MS = 60_000;

let cachedCredentials: R2StorageCredentials | undefined;
let cachedForSession: string | undefined;

function appStorageBaseUrl(): string {
  return getAppApiUrl().replace(/\/$/, "");
}

function isCredentialsExpired(credentials: R2StorageCredentials): boolean {
  const expiresAtMs = Date.parse(credentials.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  return expiresAtMs - EXPIRY_BUFFER_MS <= Date.now();
}

export function clearR2CredentialsCache(): void {
  cachedCredentials = undefined;
  cachedForSession = undefined;
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function buildScopedObjectKey(prefix: string, syncKey: string): string {
  const normalizedPrefix = normalizePrefix(prefix);
  const trimmedSyncKey = syncKey.replace(/^\/+/, "");
  const segments = trimmedSyncKey.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw new Error(`Invalid sync key "${syncKey}"`);
  }
  const objectKey = `${normalizedPrefix}${trimmedSyncKey}`;
  if (!objectKey.startsWith(normalizedPrefix)) {
    throw new Error(`Object key "${objectKey}" is outside scoped prefix "${normalizedPrefix}"`);
  }
  return objectKey;
}

function assertKeyUnderPrefix(prefix: string, objectKey: string): void {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!objectKey.startsWith(normalizedPrefix)) {
    throw new Error(`Object key "${objectKey}" is outside scoped prefix "${normalizedPrefix}"`);
  }
}

function r2ObjectUrl(credentials: R2StorageCredentials, objectKey: string): string {
  assertKeyUnderPrefix(credentials.prefix, objectKey);
  const base = credentials.endpoint.replace(/\/$/, "");
  const encodedKey = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${credentials.bucket}/${encodedKey}`;
}

function createAwsClient(credentials: R2StorageCredentials): AwsClient {
  return new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    service: "s3",
    region: credentials.region || "auto",
  });
}

async function requireAppSession(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const session = await getAppSession(context);
  if (!session) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }
  return session;
}

export async function mintR2StorageCredentials(
  context: vscode.ExtensionContext,
  options?: { ttlSeconds?: number }
): Promise<R2StorageCredentials | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
  }

  const body =
    options?.ttlSeconds !== undefined
      ? JSON.stringify({ ttlSeconds: options.ttlSeconds })
      : undefined;

  const response = await fetch(`${appStorageBaseUrl()}/v1/storage/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });

  if (response.status === 401) {
    clearR2CredentialsCache();
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }

  if (response.status === 503) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `App storage is unavailable (503)${text ? `: ${text}` : ""}`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to mint storage credentials (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as R2StorageCredentials;
}

export async function getR2StorageCredentials(
  context: vscode.ExtensionContext,
  options?: { ttlSeconds?: number }
): Promise<R2StorageCredentials | undefined> {
  const session = await getAppSession(context);
  if (!session) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }

  if (
    cachedCredentials &&
    cachedForSession === session &&
    !isCredentialsExpired(cachedCredentials)
  ) {
    return cachedCredentials;
  }

  const credentials = await mintR2StorageCredentials(context, options);
  if (!credentials) {
    return undefined;
  }

  cachedCredentials = credentials;
  cachedForSession = session;
  return credentials;
}

export async function putR2Object(
  credentials: R2StorageCredentials,
  syncKey: string,
  body: Buffer
): Promise<void> {
  const objectKey = buildScopedObjectKey(credentials.prefix, syncKey);
  const url = r2ObjectUrl(credentials, objectKey);
  const client = createAwsClient(credentials);

  const response = await client.fetch(url, {
    method: "PUT",
    body,
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to upload ${syncKey} to storage (${response.status})${text ? `: ${text}` : ""}`
    );
  }
}

export async function getR2Object(
  credentials: R2StorageCredentials,
  syncKey: string
): Promise<Buffer | undefined> {
  const objectKey = buildScopedObjectKey(credentials.prefix, syncKey);
  const url = r2ObjectUrl(credentials, objectKey);
  const client = createAwsClient(credentials);

  const response = await client.fetch(url, { method: "GET" });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to download ${syncKey} from storage (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
