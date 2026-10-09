import * as crypto from "node:crypto";

const DEFAULT_APP_STORAGE_API_BASE = "https://api.sync.bergamota.dev";

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const segment = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function accountKeyFromAppSession(session: string): string {
  return crypto.createHash("sha256").update(session).digest("hex").slice(0, 16);
}

export function appStorageAccountKey(
  session: string,
  apiBase: string = DEFAULT_APP_STORAGE_API_BASE
): string {
  const payload = decodeJwtPayload(session);
  const userId =
    typeof payload?.sub === "string"
      ? payload.sub
      : typeof payload?.userId === "string"
        ? payload.userId
        : typeof payload?.user_id === "string"
          ? payload.user_id
          : undefined;
  const base = apiBase.replace(/\/$/, "");
  if (userId && userId.length > 0) {
    return crypto
      .createHash("sha256")
      .update(`${base}|${userId}`)
      .digest("hex")
      .slice(0, 16);
  }
  return accountKeyFromAppSession(session);
}
