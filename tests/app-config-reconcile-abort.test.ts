import { describe, expect, it, vi } from "vitest";

const getR2ObjectMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app-r2-storage.js", () => ({
  getR2Object: getR2ObjectMock,
  putR2Object: vi.fn(),
}));

describe("reconcile R2 GET abort signal", () => {
  it("passes AbortSignal into getR2Object during manifest mismatch listing", async () => {
    const credentials = {
      endpoint: "https://example.r2.cloudflarestorage.com",
      bucket: "b",
      region: "auto",
      prefix: "p/",
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const controller = new AbortController();
    getR2ObjectMock.mockResolvedValue(Buffer.from("x"));

    const { listManifestObjectMismatches } = await import("../src/app-config-reconcile.js");
    await listManifestObjectMismatches(
      credentials,
      { "cursor-user/a.json": { checksum: "y", sizeBytes: 1 } },
      ["cursor-user/a.json"],
      { signal: controller.signal }
    );

    expect(getR2ObjectMock).toHaveBeenCalledWith(credentials, "cursor-user/a.json", {
      signal: controller.signal,
    });
  });
});
