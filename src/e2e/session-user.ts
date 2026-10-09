export interface AppSessionClaims {
  userId: string;
  emailVerified: boolean;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (padded.length % 4)) % 4;
    const json = Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseAppSessionClaims(sessionToken: string): AppSessionClaims | undefined {
  const parts = sessionToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload) {
    return undefined;
  }

  const userIdRaw =
    payload.sub ?? payload.userId ?? payload.user_id ?? payload.uid;
  if (typeof userIdRaw !== "string" || userIdRaw.trim().length === 0) {
    return undefined;
  }

  const emailVerified =
    payload.email_verified === true ||
    payload.emailVerified === true ||
    payload.email_verified === "true";

  return {
    userId: userIdRaw.trim(),
    emailVerified,
  };
}
