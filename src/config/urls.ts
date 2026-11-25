import * as vscode from "vscode";

export const DEFAULT_PRODUCTION_API_URL = "https://api.cursor-sync.com";
export const DEFAULT_PRODUCTION_WEBSITE_URL = "https://cursor-sync.com";
export const STAGING_API_URL = "https://api-staging.cursor-sync.com";
export const STAGING_WEBSITE_URL = "https://staging.cursor-sync.com";
export const LOCAL_API_URL = "http://localhost:8100";
export const LOCAL_WEBSITE_URL = "http://localhost:3000";

export const DEFAULT_DEVELOPER_ENVIRONMENT = "staging" as const;

export const INVALID_APP_API_URL_MESSAGE =
  "Invalid Cursor Sync API URL in settings. Custom mode allows loopback URLs only (localhost, 127.0.0.1, [::1]).";
export const INVALID_APP_WEBSITE_URL_MESSAGE =
  "Invalid Cursor Sync website URL in settings. Custom mode allows loopback URLs only (localhost, 127.0.0.1, [::1]).";
export const UNTRUSTED_APP_API_ORIGIN_MESSAGE =
  "Cursor Sync refused to send credentials to an untrusted API origin.";

export class InvalidAppApiUrlError extends Error {
  constructor(message: string = INVALID_APP_API_URL_MESSAGE) {
    super(message);
    this.name = "InvalidAppApiUrlError";
  }
}

export class InvalidAppWebsiteUrlError extends Error {
  constructor(message: string = INVALID_APP_WEBSITE_URL_MESSAGE) {
    super(message);
    this.name = "InvalidAppWebsiteUrlError";
  }
}

export class UntrustedAppApiOriginError extends Error {
  constructor(message: string = UNTRUSTED_APP_API_ORIGIN_MESSAGE) {
    super(message);
    this.name = "UntrustedAppApiOriginError";
  }
}

export const LEGACY_APP_API_URL_KEY = "appApiUrl";
export const DEVELOPER_API_URL_KEY = "developer.apiUrl";
export const DEVELOPER_WEBSITE_URL_KEY = "developer.websiteUrl";
export const DEVELOPER_ENVIRONMENT_KEY = "developer.environment";

export type DeveloperEnvironment = "production" | "staging" | "local" | "custom";

const CONFIG_SECTION = "cursorSync";

export interface UrlResolutionInputs {
  environment: DeveloperEnvironment;
  explicitApiUrl: string | undefined;
  explicitWebsiteUrl: string | undefined;
  legacyApiUrl: string | undefined;
}

function readGlobalUserString(key: string): string | undefined {
  const inspect = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect<string>(key);
  if (inspect?.globalValue !== undefined && inspect.globalValue !== null) {
    return String(inspect.globalValue);
  }
  return undefined;
}

function readEnvironment(): DeveloperEnvironment {
  const inspect = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .inspect<string>(DEVELOPER_ENVIRONMENT_KEY);
  const raw =
    inspect?.globalValue ??
    inspect?.defaultValue ??
    DEFAULT_DEVELOPER_ENVIRONMENT;
  if (raw === "local" || raw === "custom" || raw === "staging") {
    return raw;
  }
  if (raw === "production") {
    return "production";
  }
  return DEFAULT_DEVELOPER_ENVIRONMENT;
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function websiteOrigin(url: string): string {
  return new URL(stripTrailingSlash(url)).origin;
}

export const TRUSTED_APP_WEBSITE_ORIGINS: readonly string[] = [
  websiteOrigin(DEFAULT_PRODUCTION_WEBSITE_URL),
  websiteOrigin(STAGING_WEBSITE_URL),
  websiteOrigin(LOCAL_WEBSITE_URL),
];

function hostnameForPolicy(parsed: URL): string {
  if (parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")) {
    return parsed.hostname.slice(1, -1).toLowerCase();
  }
  return parsed.hostname.toLowerCase();
}

function isAsciiHostname(hostname: string): boolean {
  for (let i = 0; i < hostname.length; i++) {
    if (hostname.charCodeAt(i) > 127) {
      return false;
    }
  }
  return true;
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function assertNoUserinfo(
  parsed: URL,
  ErrorCtor: typeof InvalidAppApiUrlError | typeof InvalidAppWebsiteUrlError
): void {
  if (parsed.username || parsed.password) {
    throw new ErrorCtor();
  }
}

function assertSafeHostname(
  hostname: string,
  ErrorCtor: typeof InvalidAppApiUrlError | typeof InvalidAppWebsiteUrlError
): void {
  if (!isAsciiHostname(hostname)) {
    throw new ErrorCtor();
  }
  if (hostname.includes("xn--")) {
    throw new ErrorCtor();
  }
}

function validateCustomLoopbackUrl(
  raw: string,
  ErrorCtor: typeof InvalidAppApiUrlError | typeof InvalidAppWebsiteUrlError
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ErrorCtor();
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ErrorCtor();
  }
  assertNoUserinfo(parsed, ErrorCtor);
  const hostname = hostnameForPolicy(parsed);
  assertSafeHostname(hostname, ErrorCtor);
  if (!isLoopbackHostname(hostname)) {
    throw new ErrorCtor();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ErrorCtor();
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return stripTrailingSlash(normalized);
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

export function isTrustedAppWebsiteUrl(
  candidateUrl: string,
  inputsOverride?: UrlResolutionInputs
): boolean {
  let origin: string;
  try {
    origin = new URL(candidateUrl).origin;
  } catch {
    return false;
  }

  if (TRUSTED_APP_WEBSITE_ORIGINS.includes(origin)) {
    return true;
  }

  const inputs = inputsOverride ?? resolveUrlResolutionInputs();
  if (inputs.environment === "custom") {
    try {
      const configuredWebsite = resolveAppWebsiteUrlFromInputs(inputs);
      return origin === websiteOrigin(configuredWebsite);
    } catch {
      return false;
    }
  }

  return false;
}

export function resolveUrlResolutionInputs(): UrlResolutionInputs {
  return {
    environment: readEnvironment(),
    explicitApiUrl: readGlobalUserString(DEVELOPER_API_URL_KEY),
    explicitWebsiteUrl: readGlobalUserString(DEVELOPER_WEBSITE_URL_KEY),
    legacyApiUrl: readGlobalUserString(LEGACY_APP_API_URL_KEY),
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
    return validateCustomLoopbackUrl(raw ?? "", InvalidAppApiUrlError);
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
    const raw = inputs.explicitWebsiteUrl ?? "";
    return validateCustomLoopbackUrl(raw, InvalidAppWebsiteUrlError);
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