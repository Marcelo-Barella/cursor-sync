import * as vscode from "vscode";

export const DEFAULT_PRODUCTION_API_URL = "https://api.sync.bergamota.dev";
export const DEFAULT_PRODUCTION_WEBSITE_URL = "https://sync.bergamota.dev";
export const LOCAL_API_URL = "http://localhost:8100";
export const LOCAL_WEBSITE_URL = "http://localhost:3000";

export const LEGACY_APP_API_URL_KEY = "appApiUrl";
export const DEVELOPER_API_URL_KEY = "developer.apiUrl";
export const DEVELOPER_WEBSITE_URL_KEY = "developer.websiteUrl";
export const DEVELOPER_ENVIRONMENT_KEY = "developer.environment";

export type DeveloperEnvironment = "production" | "local" | "custom";

const CONFIG_SECTION = "cursorSync";

let lastWarnedInvalidApiRaw: string | undefined;
let lastWarnedInvalidWebsiteRaw: string | undefined;

export interface UrlResolutionInputs {
  environment: DeveloperEnvironment;
  explicitApiUrl: string | undefined;
  explicitWebsiteUrl: string | undefined;
  legacyApiUrl: string | undefined;
}

function readUserConfiguredString(key: string): string | undefined {
  const inspect = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<string>(key);
  if (inspect?.globalValue !== undefined && inspect.globalValue !== null) {
    return String(inspect.globalValue);
  }
  if (inspect?.workspaceFolderValue !== undefined && inspect.workspaceFolderValue !== null) {
    return String(inspect.workspaceFolderValue);
  }
  if (inspect?.workspaceValue !== undefined && inspect.workspaceValue !== null) {
    return String(inspect.workspaceValue);
  }
  return undefined;
}

function readEnvironment(): DeveloperEnvironment {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(DEVELOPER_ENVIRONMENT_KEY, "production");
  if (raw === "local" || raw === "custom") {
    return raw;
  }
  return "production";
}

export function normalizeHttpUrl(
  raw: string | undefined,
  fallbackUrl: string
): { url: string; usedFallback: boolean } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { url: stripTrailingSlash(fallbackUrl), usedFallback: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: stripTrailingSlash(fallbackUrl), usedFallback: true };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: stripTrailingSlash(fallbackUrl), usedFallback: true };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return { url: stripTrailingSlash(normalized), usedFallback: false };
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function warnInvalidApi(raw: string, fallbackUrl: string): void {
  if (lastWarnedInvalidApiRaw === raw) {
    return;
  }
  lastWarnedInvalidApiRaw = raw;
  void vscode.window.showWarningMessage(
    `Cursor Sync: Invalid API URL "${raw}". Using ${fallbackUrl}.`
  );
}

function warnInvalidWebsite(raw: string, fallbackUrl: string): void {
  if (lastWarnedInvalidWebsiteRaw === raw) {
    return;
  }
  lastWarnedInvalidWebsiteRaw = raw;
  void vscode.window.showWarningMessage(
    `Cursor Sync: Invalid website URL "${raw}". Using ${fallbackUrl}.`
  );
}

export function resolveUrlResolutionInputs(): UrlResolutionInputs {
  return {
    environment: readEnvironment(),
    explicitApiUrl: readUserConfiguredString(DEVELOPER_API_URL_KEY),
    explicitWebsiteUrl: readUserConfiguredString(DEVELOPER_WEBSITE_URL_KEY),
    legacyApiUrl: readUserConfiguredString(LEGACY_APP_API_URL_KEY),
  };
}

export function resolveAppApiUrlFromInputs(inputs: UrlResolutionInputs): string {
  if (inputs.explicitApiUrl === undefined && inputs.legacyApiUrl !== undefined) {
    const { url, usedFallback } = normalizeHttpUrl(
      inputs.legacyApiUrl,
      DEFAULT_PRODUCTION_API_URL
    );
    if (usedFallback) {
      warnInvalidApi(inputs.legacyApiUrl, DEFAULT_PRODUCTION_API_URL);
    }
    return url;
  }

  if (inputs.environment === "local") {
    return LOCAL_API_URL;
  }

  if (inputs.environment === "custom") {
    const { url, usedFallback } = normalizeHttpUrl(
      inputs.explicitApiUrl,
      DEFAULT_PRODUCTION_API_URL
    );
    if (usedFallback && inputs.explicitApiUrl !== undefined) {
      warnInvalidApi(inputs.explicitApiUrl, DEFAULT_PRODUCTION_API_URL);
    }
    return url;
  }

  return DEFAULT_PRODUCTION_API_URL;
}

export function resolveAppWebsiteUrlFromInputs(inputs: UrlResolutionInputs): string {
  if (inputs.environment === "local") {
    return LOCAL_WEBSITE_URL;
  }

  if (inputs.environment === "custom") {
    const { url, usedFallback } = normalizeHttpUrl(
      inputs.explicitWebsiteUrl,
      DEFAULT_PRODUCTION_WEBSITE_URL
    );
    if (usedFallback && inputs.explicitWebsiteUrl !== undefined) {
      warnInvalidWebsite(inputs.explicitWebsiteUrl, DEFAULT_PRODUCTION_WEBSITE_URL);
    }
    return url;
  }

  return DEFAULT_PRODUCTION_WEBSITE_URL;
}

export function getAppApiUrl(): string {
  return resolveAppApiUrlFromInputs(resolveUrlResolutionInputs());
}

export function getAppWebsiteUrl(): string {
  return resolveAppWebsiteUrlFromInputs(resolveUrlResolutionInputs());
}

export function registerDeveloperUrlConfigurationListener(
  onUrlsChanged: () => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration(`${CONFIG_SECTION}.${DEVELOPER_ENVIRONMENT_KEY}`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.${DEVELOPER_API_URL_KEY}`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.${DEVELOPER_WEBSITE_URL_KEY}`) ||
      event.affectsConfiguration(`${CONFIG_SECTION}.${LEGACY_APP_API_URL_KEY}`)
    ) {
      onUrlsChanged();
    }
  });
}
