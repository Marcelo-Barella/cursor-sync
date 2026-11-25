import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidAppApiUrlError,
  LOCAL_API_URL,
  STAGING_API_URL,
  resolveAppApiUrlFromInputs,
  type UrlResolutionInputs,
} from "../src/config/urls.js";

function inputs(partial: Partial<UrlResolutionInputs>): UrlResolutionInputs {
  return {
    environment: "production",
    explicitApiUrl: undefined,
    explicitWebsiteUrl: undefined,
    legacyApiUrl: undefined,
    ...partial,
  };
}

describe("config/urls workspace isolation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("vscode");
  });

  it("ignores workspace-level apiUrl and environment overrides", async () => {
    vi.doMock("vscode", () => ({
      workspace: {
        getConfiguration: () => ({
          get: (key: string, defaultValue?: string) => {
            if (key === "developer.environment") {
              return "custom";
            }
            if (key === "developer.apiUrl") {
              return "https://evil.example";
            }
            return defaultValue;
          },
          inspect: (key: string) => {
            if (key === "developer.environment") {
              return {
                workspaceValue: "custom",
                globalValue: "staging",
                defaultValue: "staging",
              };
            }
            if (key === "developer.apiUrl") {
              return {
                workspaceValue: "https://evil.example",
                globalValue: undefined,
              };
            }
            if (key === "appApiUrl") {
              return { workspaceValue: "https://evil.example" };
            }
            return undefined;
          },
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
    }));

    const { getAppApiUrl } = await import("../src/config/urls.js");
    expect(getAppApiUrl()).toBe(STAGING_API_URL);
  });
});

describe("config/urls custom loopback policy", () => {
  it("rejects non-loopback custom API URLs", () => {
    expect(() =>
      resolveAppApiUrlFromInputs(
        inputs({
          environment: "custom",
          explicitApiUrl: "https://evil.example",
        })
      )
    ).toThrow(InvalidAppApiUrlError);
  });

  it("allows localhost custom API URLs", () => {
    expect(
      resolveAppApiUrlFromInputs(
        inputs({
          environment: "custom",
          explicitApiUrl: "http://localhost:8100",
        })
      )
    ).toBe(LOCAL_API_URL);
  });

  it("rejects punycode hostnames", () => {
    expect(() =>
      resolveAppApiUrlFromInputs(
        inputs({
          environment: "custom",
          explicitApiUrl: "http://xn--evil.localhost:8100",
        })
      )
    ).toThrow(InvalidAppApiUrlError);
  });
});