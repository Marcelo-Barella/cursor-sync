import { describe, it, expect, vi } from "vitest";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("packaging", () => {
  const tmpDir = path.join(os.tmpdir(), "cursor-sync-test-pkg-" + Date.now());

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("produces deterministic checksums", async () => {
    const { packageFiles } = await import("../src/packaging.js");
    await fs.mkdir(tmpDir, { recursive: true });

    const filePath = path.join(tmpDir, "test.json");
    await fs.writeFile(filePath, '{"key": "value"}');

    const files = [{ absolutePath: filePath, relativeSyncKey: "cursor-user/test.json" }];
    const { packaged, manifest } = await packageFiles(files, "default");

    const entry = packaged.get("cursor-user/test.json");
    expect(entry).toBeDefined();

    const expectedChecksum = crypto
      .createHash("sha256")
      .update('{"key": "value"}')
      .digest("hex");
    expect(entry!.checksum).toBe(expectedChecksum);
    expect(manifest.files["cursor-user/test.json"].checksum).toBe(expectedChecksum);
  });

  it("sorts files by key in manifest", async () => {
    const { packageFiles } = await import("../src/packaging.js");
    await fs.mkdir(tmpDir, { recursive: true });

    const fileB = path.join(tmpDir, "b.json");
    const fileA = path.join(tmpDir, "a.json");
    await fs.writeFile(fileB, "b");
    await fs.writeFile(fileA, "a");

    const files = [
      { absolutePath: fileB, relativeSyncKey: "cursor-user/b.json" },
      { absolutePath: fileA, relativeSyncKey: "cursor-user/a.json" },
    ];
    const { manifest } = await packageFiles(files, "default");

    const keys = Object.keys(manifest.files);
    expect(keys[0]).toBe("cursor-user/a.json");
    expect(keys[1]).toBe("cursor-user/b.json");
  });

  it("base64 encodes non-UTF-8 files", async () => {
    const { packageFiles } = await import("../src/packaging.js");
    await fs.mkdir(tmpDir, { recursive: true });

    const filePath = path.join(tmpDir, "binary.bin");
    const binaryContent = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81]);
    await fs.writeFile(filePath, binaryContent);

    const files = [
      { absolutePath: filePath, relativeSyncKey: "dot-cursor/binary.bin" },
    ];
    const { packaged, manifest } = await packageFiles(files, "default");

    const entry = packaged.get("dot-cursor/binary.bin");
    expect(entry).toBeDefined();
    expect(entry!.encoding).toBe("base64");
    expect(manifest.files["dot-cursor/binary.bin"].encoding).toBe("base64");

    const decoded = Buffer.from(entry!.content, "base64");
    expect(decoded).toEqual(binaryContent);
  });

  it("sets correct manifest metadata", async () => {
    const { packageFiles } = await import("../src/packaging.js");
    await fs.mkdir(tmpDir, { recursive: true });

    const filePath = path.join(tmpDir, "test.json");
    await fs.writeFile(filePath, "{}");

    const files = [{ absolutePath: filePath, relativeSyncKey: "cursor-user/test.json" }];
    const { manifest } = await packageFiles(files, "my-profile");

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.syncProfileName).toBe("my-profile");
    expect(manifest.sourceOS).toBe(process.platform);
    expect(manifest.sourceMachineId).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.createdAt).toBeTruthy();
  });

  it("records correct sizeBytes", async () => {
    const { packageFiles } = await import("../src/packaging.js");
    await fs.mkdir(tmpDir, { recursive: true });

    const content = "hello world";
    const filePath = path.join(tmpDir, "size.txt");
    await fs.writeFile(filePath, content);

    const files = [{ absolutePath: filePath, relativeSyncKey: "cursor-user/size.txt" }];
    const { packaged, manifest } = await packageFiles(files, "default");

    expect(packaged.get("cursor-user/size.txt")!.sizeBytes).toBe(
      Buffer.byteLength(content)
    );
    expect(manifest.files["cursor-user/size.txt"].sizeBytes).toBe(
      Buffer.byteLength(content)
    );
  });
});
