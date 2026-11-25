import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_API_URL } from "../src/config/urls.js";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

describe("app-api-http authorizedAppApiFetch", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });


  it("sends Bearer only to the pinned API origin", async () => {
    vi.doMock("vscode", () => ({
      workspace: {
        getConfiguration: () => ({
          inspect: (key: string) => {
            if (key === "developer.environment") {
              return { globalValue: "staging", defaultValue: "staging" };
            }
            return undefined;
          },
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
    }));

    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const { authorizedAppApiFetch } = await import("../src/app-api-http.js");
    await authorizedAppApiFetch("jwt", `${STAGING_API_URL}/v1/keys`, { method: "GET" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt");
  });

  it("refuses bearer to an untrusted origin", async () => {
    vi.doMock("vscode", () => ({
      workspace: {
        getConfiguration: () => ({
          inspect: () => ({ globalValue: "staging", defaultValue: "staging" }),
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
    }));

    const { authorizedAppApiFetch } = await import("../src/app-api-http.js");
    await expect(
      authorizedAppApiFetch("jwt", "https://evil.example/v1/keys", { method: "GET" })
    ).rejects.toThrow(/untrusted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect to another origin with credentials", async () => {
    vi.doMock("vscode", () => ({
      workspace: {
        getConfiguration: () => ({
          inspect: (key: string) => {
            if (key === "developer.environment") {
              return { globalValue: "staging", defaultValue: "staging" };
            }
            return undefined;
          },
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
    }));

    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/take-token" },
      })
    );

    const { authorizedAppApiFetch } = await import("../src/app-api-http.js");
    const response = await authorizedAppApiFetch("jwt", `${STAGING_API_URL}/v1/keys`, {
      method: "GET",
    });

    expect(response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt");
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});