import type { ApiResult, GistResponse, FailureCategory } from "./types.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "cursor-sync-extension";

export class GistClient {
  private pat: string;

  constructor(pat: string) {
    this.pat = pat;
  }

  async validateToken(): Promise<ApiResult<boolean>> {
    return this.request<boolean>("GET", "/gists?per_page=1", undefined, () => true);
  }

  async findExistingGist(): Promise<ApiResult<GistResponse | null>> {
    return this.request<GistResponse | null>("GET", "/gists", undefined, (data) => {
      const gists = data as GistResponse[];
      const found = gists.find((g) => g.description === "Cursor Sync - Settings Backup");
      return found || null;
    });
  }

  async getGist(gistId: string): Promise<ApiResult<GistResponse>> {
    return this.request<GistResponse>("GET", `/gists/${gistId}`);
  }

  async createGist(
    files: Record<string, { content: string }>,
    description: string
  ): Promise<ApiResult<GistResponse>> {
    return this.request<GistResponse>("POST", "/gists", {
      description,
      public: false,
      files,
    });
  }

  async updateGist(
    gistId: string,
    files: Record<string, { content: string } | null>
  ): Promise<ApiResult<GistResponse>> {
    return this.request<GistResponse>("PATCH", `/gists/${gistId}`, { files });
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    transform?: (data: unknown) => T
  ): Promise<ApiResult<T>> {
    const url = `${GITHUB_API}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": USER_AGENT,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      return {
        ok: false,
        error: {
          category: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Network request failed",
        },
      };
    }

    const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
    const retryAfterHeader = response.headers.get("Retry-After");

    if (response.status === 429) {
      return {
        ok: false,
        error: {
          category: "RATE_LIMITED",
          message: "GitHub API rate limit exceeded",
          statusCode: 429,
          retryAfter: retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60,
        },
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: {
          category: "AUTH_FAILED",
          message: `Authentication failed (${response.status})`,
          statusCode: response.status,
        },
      };
    }

    if (response.status >= 500) {
      return {
        ok: false,
        error: {
          category: "NETWORK_ERROR",
          message: `Server error (${response.status})`,
          statusCode: response.status,
        },
      };
    }

    if (!response.ok) {
      let errorMessage = `GitHub API error (${response.status})`;
      try {
        const errorBody = (await response.json()) as { message?: string };
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch {}
      return {
        ok: false,
        error: {
          category: "UNKNOWN" as FailureCategory,
          message: errorMessage,
          statusCode: response.status,
        },
      };
    }

    try {
      const data = await response.json();
      const result = transform ? transform(data) : (data as T);
      return { ok: true, data: result };
    } catch (err) {
      return {
        ok: false,
        error: {
          category: "UNKNOWN",
          message: "Failed to parse response JSON",
        },
      };
    }
  }
}
