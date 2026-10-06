import type { Manifest } from "../types.js";
import type { AppConfigsPayloadFile } from "../app-configs.js";

export const E2E_MANIFEST_PAYLOAD_SCHEMA = 1 as const;

export interface E2eConfigsManifestPayload {
  schemaVersion: typeof E2E_MANIFEST_PAYLOAD_SCHEMA;
  manifest: Manifest;
  files: Record<string, AppConfigsPayloadFile>;
}

export function serializeManifestPayload(payload: E2eConfigsManifestPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function parseManifestPayload(bytes: Buffer): E2eConfigsManifestPayload {
  const parsed = JSON.parse(bytes.toString("utf8")) as E2eConfigsManifestPayload;
  if (parsed.schemaVersion !== E2E_MANIFEST_PAYLOAD_SCHEMA) {
    throw new Error(`Unsupported manifest payload schema ${String(parsed.schemaVersion)}`);
  }
  return parsed;
}
