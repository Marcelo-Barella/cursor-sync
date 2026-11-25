import {
  getAppApiUrl,
  UNTRUSTED_APP_API_ORIGIN_MESSAGE,
  UntrustedAppApiOriginError,
} from "./config/urls.js";

function trustedAppApiOrigin(): string {
  return new URL(getAppApiUrl().replace(/\/+$/, "")).origin;
}

export function assertTrustedAppApiRequestUrl(requestUrl: string): void {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    throw new UntrustedAppApiOriginError();
  }
  const trustedOrigin = trustedAppApiOrigin();
  if (requestOrigin !== trustedOrigin) {
    throw new UntrustedAppApiOriginError(
      `${UNTRUSTED_APP_API_ORIGIN_MESSAGE} (expected ${trustedOrigin}, got ${requestOrigin}).`
    );
  }
}

const BEARER_HEADER = "Authorization";

function buildBearerHeader(session: string): Record<string, string> {
  return {
    [BEARER_HEADER]: `Bearer ${session}`,
    Accept: "application/json",
  };
}

export function appApiAuthHeaders(session: string): Record<string, string> {
  return buildBearerHeader(session);
}

export async function readAppApiErrorJson(
  response: Response
): Promise<{ error?: string; message?: string }> {
  try {
    return (await response.json()) as { error?: string; message?: string };
  } catch {
    return {};
  }
}

function mergeHeaders(
  session: string | undefined,
  initHeaders?: RequestInit["headers"]
): Record<string, string> {
  const merged: Record<string, string> = session
    ? { ...buildBearerHeader(session) }
    : { Accept: "application/json" };
  if (!initHeaders) {
    return merged;
  }
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      merged[key] = value;
    });
    return merged;
  }
  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      merged[key] = value;
    }
    return merged;
  }
  if (typeof initHeaders === "object") {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export async function appApiFetch(
  requestUrl: string,
  init?: RequestInit & { session?: string }
): Promise<Response> {
  assertTrustedAppApiRequestUrl(requestUrl);
  const { session, ...fetchInit } = init ?? {};
  const headers = mergeHeaders(session, fetchInit.headers);
  const response = await fetch(requestUrl, {
    ...fetchInit,
    redirect: "manual",
    headers,
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const nextUrl = new URL(location, requestUrl).href;
    try {
      assertTrustedAppApiRequestUrl(nextUrl);
    } catch {
      return response;
    }
    return appApiFetch(nextUrl, {
      ...fetchInit,
      session,
      method: fetchInit.method ?? "GET",
    });
  }

  return response;
}

export async function authorizedAppApiFetch(
  session: string,
  requestUrl: string,
  init?: RequestInit
): Promise<Response> {
  return appApiFetch(requestUrl, { ...init, session });
}