import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { appApiFetch } from "./app-api-http.js";
import { getAppApiUrl } from "./config/urls.js";
import { getLogger } from "./diagnostics.js";

const CLIENT_ID_KEY = "cursorSync.analytics.clientId";
const TELEMETRY_TIMEOUT_MS = 4000;

function logAnalyticsFailure(message: string): void {
  try {
    getLogger().appendLine(`[Analytics] ${message}`);
  } catch {
    // Logger unavailable during tests or early activation.
  }
}

export function isAnalyticsSendingEnabled(): boolean {
  try {
    return vscode.env.isTelemetryEnabled;
  } catch {
    return false;
  }
}

export function getOrCreateClientId(
  context: vscode.ExtensionContext
): string {
  try {
    const globalState = context.globalState;
    if (!globalState?.get) {
      return crypto.randomUUID();
    }
    let clientId = globalState.get<string>(CLIENT_ID_KEY);
    if (!clientId) {
      clientId = crypto.randomUUID();
      void Promise.resolve(globalState.update(CLIENT_ID_KEY, clientId)).catch((err) => {
        logAnalyticsFailure(
          `Failed to persist client id: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    return clientId;
  } catch (err) {
    logAnalyticsFailure(
      `Failed to read client id: ${err instanceof Error ? err.message : String(err)}`
    );
    return crypto.randomUUID();
  }
}

/**
 * Sends an event to the Cursor Sync API telemetry endpoint. Fire-and-forget; never throws.
 * Caller must ensure params contain no sensitive data (token, gistId, paths, error.message).
 */
export function sendEvent(
  context: vscode.ExtensionContext,
  name: string,
  params: Record<string, string | number | boolean | undefined>
): void {
  if (!isAnalyticsSendingEnabled()) {
    return;
  }

  try {
    const clientId = getOrCreateClientId(context);
    const sanitizedParams: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        sanitizedParams[key] = value as string | number | boolean;
      }
    }

    const apiBase = getAppApiUrl();
    const url = `${apiBase.replace(/\/+$/, "")}/v1/telemetry`;
    const body = JSON.stringify({
      client_id: clientId,
      events: [{ name, params: sanitizedParams }],
    });

    try {
      getLogger().appendLine(
        "[Analytics] Sending event: " + name + " " + JSON.stringify(sanitizedParams)
      );
    } catch {
      // ignore
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    void appApiFetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    })
      .finally(() => clearTimeout(timeout))
      .then((response) => {
        if (!response.ok) {
          return response.text().then((text) => {
            logAnalyticsFailure(
              `Telemetry API error: status=${response.status} body=${text}`
            );
          });
        }
      })
      .catch((err) => {
        logAnalyticsFailure(
          `Failed to send event "${name}": ${err instanceof Error ? err.message : String(err)}`
        );
      });
  } catch (err) {
    logAnalyticsFailure(
      `Failed to prepare event "${name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}