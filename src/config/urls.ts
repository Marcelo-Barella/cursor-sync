import * as vscode from "vscode";

export const DEFAULT_PRODUCTION_API_URL = "https://api.sync.bergamota.dev";
export const DEFAULT_PRODUCTION_WEBSITE_URL = "https://sync.bergamota.dev";
export const STAGING_API_URL = "https://api-staging.cursor-sync.com";
export const STAGING_WEBSITE_URL = "https://staging.cursor-sync.com";
export const LOCAL_API_URL = "http://localhost:8100";
export const LOCAL_WEBSITE_URL = "http://localhost:3000";

export const DEFAULT_DEVELOPER_ENVIRONMENT = "staging" as const;

export const INVALID_APP_API_URL_MESSAGE = "Invalid Cursor Sync API URL in settings.";
export const INVALID_APP_WEBSITE_URL_MESSAGE = "Invalid Cursor Sync website URL in settings.";

export class InvalidAppApiUrlError extends Error {
  constructor() {
    super(INVALID_APP_API_URL_MESSAGE);
    this.name = "InvalidAppApiUrlError";
  }
}

export class InvalidAppWebsiteUrlError extends Error {
  constructor() {
    super(INVALID_APP_WEBSITE_URL_MESSAGE);
    this.name = "InvalidAppWebsiteUrlError";
  }
}

export const LEGACY_APP_API_URL_KEY = "appApiUrl";
export const DEVELOPER_API_URL_KEY = "developer.apiUrl";
export const DEVELOPER_WEBSITE_URL_KEY = "developer.websiteUrl";
export const DEVELOPER_ENVIRONMENT_KEY = "developer.environment";

export type DeveloperEnvironment = "production" | "staging" | "local" | "custom";

const CONFIG_SECTION = "cursorSync";

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
    .get<string>(DEVELOPER_ENVIRONMENT_KEY, DEFAULT_DEVELOPER_ENVIRONMENT);
  if (raw === "local" || raw === "custom" || raw === "staging") {
    return raw;
  }
  if (raw === "production") {
    return "production";
  }
  return DEFAULT_DEVELOPER_ENVIRONMENT;
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
  if (inputs.environment === "local") {
    return LOCAL_API_URL;
  }

  if (inputs.environment === "staging") {
    return STAGING_API_URL;
  }

  if (inputs.environment === "custom") {
    const raw =
      inputs.explicitApiUrl !== undefined ? inputs.explicitApiUrl : inputs.legacyApiUrl;
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
      throw new InvalidAppApiUrlError();
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new InvalidAppApiUrlError();
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new InvalidAppApiUrlError();
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    const normalized = `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
    return stripTrailingSlash(normalized);
  }

  return DEFAULT_PRODUCTION_API_URL;
}

export function resolveAppWebsiteUrlFromInputs(inputs: UrlResolutionInputs): string {
  if (inputs.environment === "local") {
    return LOCAL_WEBSITE_URL;
  }

  if (inputs.environment === "staging") {
    return STAGING_WEBSITE_URL;
  }

  if (inputs.environment === "custom") {
    const trimmed = (inputs.explicitWebsiteUrl ?? "").trim();
    if (!trimmed) {
      throw new InvalidAppWebsiteUrlError();
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new InvalidAppWebsiteUrlError();
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new InvalidAppWebsiteUrlError();
    }
    const pathPart = parsed.pathname.replace(/\/+$/, "");
    const normalized = `${parsed.protocol}//${parsed.host}${pathPart}${parsed.search}${parsed.hash}`;
    return stripTrailingSlash(normalized);
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
