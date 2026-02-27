import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("GistClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("validates token successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "X-RateLimit-Remaining": "4999" }),
      json: async () => [],
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_test_token");
    const result = await client.validateToken();

    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/gists?per_page=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "token ghp_test_token",
          "User-Agent": "cursor-sync-extension",
        }),
      })
    );
  });

  it("handles auth failure (401)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ message: "Bad credentials" }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("bad_token");
    const result = await client.validateToken();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("AUTH_FAILED");
      expect(result.error.statusCode).toBe(401);
    }
  });

  it("handles rate limiting (429)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "30" }),
      json: async () => ({ message: "rate limit exceeded" }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.validateToken();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("RATE_LIMITED");
      expect(result.error.retryAfter).toBe(30);
    }
  });

  it("handles server error (500)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ message: "Internal Server Error" }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.validateToken();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("NETWORK_ERROR");
      expect(result.error.statusCode).toBe(500);
    }
  });

  it("handles network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.validateToken();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("NETWORK_ERROR");
      expect(result.error.message).toContain("ECONNREFUSED");
    }
  });

  it("creates a private gist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
      json: async () => ({
        id: "gist123",
        html_url: "https://gist.github.com/gist123",
        description: "test",
        files: {},
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.createGist(
      { "test.json": { content: "{}" } },
      "test gist"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("gist123");
    }

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.public).toBe(false);
  });

  it("updates a gist with file deletion", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "gist123",
        html_url: "https://gist.github.com/gist123",
        description: "test",
        files: {},
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.updateGist("gist123", {
      "new-file.json": { content: "{}" },
      "old-file.json": null,
    });

    expect(result.ok).toBe(true);

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.files["new-file.json"].content).toBe("{}");
    expect(body.files["old-file.json"]).toBeNull();
  });

  it("fetches a gist by ID", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "gist456",
        html_url: "https://gist.github.com/gist456",
        description: "sync",
        files: {
          "manifest.json": { content: "{}" },
        },
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.getGist("gist456");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("gist456");
      expect(result.data.files["manifest.json"]).toBeDefined();
    }
  });

  it("finds existing gist by description", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [
        {
          id: "other1",
          html_url: "https://gist.github.com/other1",
          description: "Some other gist",
          files: {},
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
        {
          id: "sync_gist_42",
          html_url: "https://gist.github.com/sync_gist_42",
          description: "Cursor Sync - Settings Backup",
          files: {},
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.findExistingGist();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("sync_gist_42");
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/gists?per_page=100&page=1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns undefined when no matching gist exists", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [
        {
          id: "unrelated1",
          html_url: "https://gist.github.com/unrelated1",
          description: "My notes",
          files: {},
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.findExistingGist();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("finds gist on second page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `filler_${i}`,
      html_url: `https://gist.github.com/filler_${i}`,
      description: `Filler gist ${i}`,
      files: {},
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    }));

    const page2 = [
      {
        id: "found_on_page2",
        html_url: "https://gist.github.com/found_on_page2",
        description: "Cursor Sync - Settings Backup",
        files: {},
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    ];

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => page1,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => page2,
      });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("ghp_token");
    const result = await client.findExistingGist();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("found_on_page2");
    }

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/gists?per_page=100&page=2",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("propagates API errors from findExistingGist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ message: "Bad credentials" }),
    });

    const { GistClient } = await import("../src/gist.js");
    const client = new GistClient("bad_token");
    const result = await client.findExistingGist();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("AUTH_FAILED");
      expect(result.error.statusCode).toBe(401);
    }
  });
});
