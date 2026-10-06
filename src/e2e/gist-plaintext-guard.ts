import type { GistClient } from "../gist.js";
import { tryReadGistE2eMarker } from "./gist-bundle.js";

export const PLAINTEXT_GIST_BLOCKED_MESSAGE =
  "This Gist is encrypted with Cursor Sync. Log in and unlock before writing plaintext.";

export const GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE =
  "Couldn't verify gist encryption state. Try again.";

export type GistEncryptionProbeResult =
  | { state: "plain" }
  | { state: "encrypted" }
  | { state: "unknown" };

export async function probeSyncGistEncryption(
  client: GistClient,
  gistId?: string
): Promise<GistEncryptionProbeResult> {
  let id = gistId;
  if (!id) {
    const found = await client.findExistingGist();
    if (!found.ok) {
      return { state: "unknown" };
    }
    if (!found.data) {
      return { state: "plain" };
    }
    id = found.data.id;
  }
  const gist = await client.getGist(id);
  if (!gist.ok) {
    return { state: "unknown" };
  }
  const encrypted = tryReadGistE2eMarker(gist.data.files) !== undefined;
  return encrypted ? { state: "encrypted" } : { state: "plain" };
}

/** @deprecated Use probeSyncGistEncryption */
export async function remoteSyncGistIsEncrypted(
  client: GistClient,
  gistId?: string
): Promise<boolean> {
  const probe = await probeSyncGistEncryption(client, gistId);
  return probe.state === "encrypted";
}

export async function assertPlaintextGistWriteAllowed(
  client: GistClient,
  gistId?: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const probe = await probeSyncGistEncryption(client, gistId);
  if (probe.state === "encrypted") {
    return { ok: false, message: PLAINTEXT_GIST_BLOCKED_MESSAGE };
  }
  if (probe.state === "unknown") {
    return { ok: false, message: GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE };
  }
  return { ok: true };
}
