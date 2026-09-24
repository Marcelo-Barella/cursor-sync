import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRODUCTION_API_URL,
  DEFAULT_PRODUCTION_WEBSITE_URL,
  LOCAL_API_URL,
  LOCAL_WEBSITE_URL,
  normalizeHttpUrl,
  resolveAppApiUrlFromInputs,
  resolveAppWebsiteUrlFromInputs,
  type UrlResolutionInputs,
} from "../src/config/urls.js";

const showWarningMessageMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      inspect: () => undefined,
    }),
  },
  window: {
    showWarningMessage: (...args: unknown[]) => showWarningMessageMock(...args),
  },
}));

function inputs(partial: Partial<UrlResolutionInputs>): UrlResolutionInputs {
  return {
    environment: "production",
    explicitApiUrl: undefined,
    explicitWebsiteUrl: undefined,
    legacyApiUrl: undefined,
    ...partial,
  };
}

describe("config/urls normalizeHttpUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeHttpUrl("https://api.example.com/", DEFAULT_PRODUCTION_API_URL).url).toBe(
      "https://api.example.com"
    );
  });

  it("falls back on invalid protocol", () => {
    const result = normalizeHttpUrl("ftp://bad", DEFAULT_PRODUCTION_API_URL);
    expect(result.usedFallback).toBe(true);
    expect(result.url).toBe(DEFAULT_PRODUCTION_API_URL);
  });

  it("falls back on empty value", () => {
    const result = normalizeHttpUrl("  ", DEFAULT_PRODUCTION_API_URL);
    expect(result.usedFallback).toBe(true);
    expect(result.url).toBe(DEFAULT_PRODUCTION_API_URL);
  });
});

describe("config/urls resolveAppApiUrlFromInputs", () => {
  beforeEach(() => {
    showWarningMessageMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("defaults to production API URL", () => {
    expect(resolveAppApiUrlFromInputs(inputs({}))).toBe(DEFAULT_PRODUCTION_API_URL);
  });

  it("uses local preset", () => {
    expect(resolveAppApiUrlFromInputs(inputs({ environment: "local" }))).toBe(LOCAL_API_URL);
  });

  it("uses custom explicit API URL", () => {
    expect(
      resolveAppApiUrlFromInputs(
        inputs({
          environment: "custom",
          explicitApiUrl: "https://custom.api.example/",
        })
      )
    ).toBe("https://custom.api.example");
  });

  it("honors legacy appApiUrl when new key is unset", () => {
    expect(
      resolveAppApiUrlFromInputs(
        inputs({
          legacyApiUrl: "http://localhost:8100",
        })
      )
    ).toBe(LOCAL_API_URL);
  });

  it("prefers explicit developer.apiUrl over legacy when both set in custom mode", () => {
    expect(
      resolveAppApiUrlFromInputs(
        inputs({
          environment: "custom",
          explicitApiUrl: "https://new.api.example",
          legacyApiUrl: "http://localhost:8100",
        })
      )
    ).toBe("https://new.api.example");
  });

  it("falls back to production default for invalid custom API URL", async () => {
    const { resolveAppApiUrlFromInputs: resolve } = await import("../src/config/urls.js");
    expect(
      resolve(
        inputs({
          environment: "custom",
          explicitApiUrl: "not-a-url",
        })
      )
    ).toBe(DEFAULT_PRODUCTION_API_URL);
    expect(showWarningMessageMock).toHaveBeenCalled();
  });
});

describe("config/urls resolveAppWebsiteUrlFromInputs", () => {
  it("defaults to production website URL", () => {
    expect(resolveAppWebsiteUrlFromInputs(inputs({}))).toBe(DEFAULT_PRODUCTION_WEBSITE_URL);
  });

  it("uses local website preset", () => {
    expect(resolveAppWebsiteUrlFromInputs(inputs({ environment: "local" }))).toBe(
      LOCAL_WEBSITE_URL
    );
  });

  it("uses custom explicit website URL", () => {
    expect(
      resolveAppWebsiteUrlFromInputs(
        inputs({
          environment: "custom",
          explicitWebsiteUrl: "https://custom.web.example/",
        })
      )
    ).toBe("https://custom.web.example");
  });
});

describe("config/urls live configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    showWarningMessageMock.mockReset();
  });

  it("reads updated settings on each getAppApiUrl call without re-activation", async () => {
    let environment = "production";
    const inspectValues: Record<string, string | undefined> = {};

    vi.doMock("vscode", () => ({
      workspace: {
        getConfiguration: () => ({
          get: (key: string, defaultValue?: string) => {
            if (key === "developer.environment") {
              return environment;
            }
            return defaultValue;
          },
          inspect: (key: string) => {
            const value = inspectValues[key];
            return value === undefined ? undefined : { globalValue: value };
          },
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
      window: {
        showWarningMessage: (...args: unknown[]) => showWarningMessageMock(...args),
      },
    }));

    const { getAppApiUrl } = await import("../src/config/urls.js");
    expect(getAppApiUrl()).toBe(DEFAULT_PRODUCTION_API_URL);

    environment = "local";
    expect(getAppApiUrl()).toBe(LOCAL_API_URL);

    environment = "production";
    inspectValues["appApiUrl"] = "http://localhost:8100";
    expect(getAppApiUrl()).toBe(LOCAL_API_URL);
  });
});
