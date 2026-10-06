import type { AppConfigsPayloadV1 } from "../app-configs.js";

function isAppConfigsPayloadV1(value: unknown): value is AppConfigsPayloadV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as AppConfigsPayloadV1;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}

/** True when GET /configs still carries a legacy plaintext payload (not null, {}, or empty files). */
export function hasLegacyConfigsPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) {
    return false;
  }
  if (typeof payload !== "object") {
    return false;
  }
  if (Object.keys(payload as object).length === 0) {
    return false;
  }
  if (!isAppConfigsPayloadV1(payload)) {
    return false;
  }
  return Object.keys(payload.files).length > 0;
}
