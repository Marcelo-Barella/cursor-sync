import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { SyncFileEntry, PackagedFile, Manifest, ManifestFileEntry } from "./types.js";

export async function packageFiles(
  files: SyncFileEntry[],
  profileName: string
): Promise<{ packaged: Map<string, PackagedFile>; manifest: Manifest }> {
  const sorted = [...files].sort((a, b) =>
    a.relativeSyncKey.localeCompare(b.relativeSyncKey)
  );

  const packaged = new Map<string, PackagedFile>();
  const manifestFiles: Record<string, ManifestFileEntry> = {};

  for (const file of sorted) {
    const buf = await fs.readFile(file.absolutePath);
    const isUtf8 = isValidUtf8(buf);

    const content = isUtf8 ? buf.toString("utf-8") : buf.toString("base64");
    const checksum = crypto.createHash("sha256").update(buf).digest("hex");
    const sizeBytes = buf.length;

    const entry: PackagedFile = { content, checksum, sizeBytes };
    const manifestEntry: ManifestFileEntry = { checksum, sizeBytes };

    if (!isUtf8) {
      entry.encoding = "base64";
      manifestEntry.encoding = "base64";
    }

    packaged.set(file.relativeSyncKey, entry);
    manifestFiles[file.relativeSyncKey] = manifestEntry;
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    syncProfileName: profileName,
    createdAt: new Date().toISOString(),
    sourceMachineId: computeMachineId(),
    sourceOS: process.platform as Manifest["sourceOS"],
    files: manifestFiles,
  };

  return { packaged, manifest };
}

export function computeChecksum(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computeMachineId(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return decoded !== undefined;
  } catch {
    return false;
  }
}
