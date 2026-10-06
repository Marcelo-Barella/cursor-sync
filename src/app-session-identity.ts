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

export function resolveAppSessionEmail(sessionToken: string): string | undefined {
  const payload = decodeJwtPayload(sessionToken);
  if (!payload) {
    return undefined;
  }
  for (const key of ["email", "user_email", "preferred_username"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
