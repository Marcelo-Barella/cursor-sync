import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { getLogger } from "./diagnostics.js";

const CLIENT_ID_KEY = "cursorSync.analytics.clientId";
const GA4_COLLECT_URL = "https://www.google-analytics.com/mp/collect";
const GA4_MEASUREMENT_ID = "G-0GVF6BNM25";
const GA4_API_SECRET = "rfkGZLnCRZSlhkSiHA1eTg";

export function getOrCreateClientId(
  context: vscode.ExtensionContext
): string {
  let clientId = context.globalState.get<string>(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = crypto.randomUUID();
    void context.globalState.update(CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

/**
 * Sends an event to GA4 via Measurement Protocol. Fire-and-forget; never throws.
 * Caller must ensure params contain no sensitive data (token, gistId, paths, error.message).
 */
export function sendEvent(
  context: vscode.ExtensionContext,
  name: string,
  params: Record<string, string | number | boolean | undefined>
): void {
  const clientId = getOrCreateClientId(context);
  const sanitizedParams: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      sanitizedParams[key] = value as string | number | boolean;
    }
  }

  const url = `${GA4_COLLECT_URL}?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;
  const body = JSON.stringify({
    client_id: clientId,
    events: [{ name, params: sanitizedParams }],
  });

  getLogger().appendLine(
    "[Analytics] Sending event: " + name + " " + JSON.stringify(sanitizedParams)
  );

  fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  })
    .then((response) => {
      if (!response.ok) {
        return response.text().then((text) => {
          getLogger().appendLine(
            `[Analytics] GA returned error: status=${response.status} body=${text}`
          );
        });
      }
    })
    .catch((err) => {
      getLogger().appendLine(
        `[Analytics] Failed to send event "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    });
}
