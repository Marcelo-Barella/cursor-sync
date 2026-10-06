import type { GistClient } from "../gist.js";
import { remoteGistHasE2eMarker } from "./gist-read.js";

export const PLAINTEXT_GIST_BLOCKED_MESSAGE =
  "This Gist is encrypted with Cursor Sync. Log in and unlock before writing plaintext.";

export async function remoteSyncGistIsEncrypted(
  client: GistClient,
  gistId?: string
): Promise<boolean> {
  let id = gistId;
  if (!id) {
    const found = await client.findExistingGist();
    if (!found.ok || !found.data) {
      return false;
    }
    id = found.data.id;
  }
  const gist = await client.getGist(id);
  if (!gist.ok) {
    return false;
  }
  return remoteGistHasE2eMarker(gist.data.files);
}

export async function assertPlaintextGistWriteAllowed(
  client: GistClient,
  gistId?: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const encrypted = await remoteSyncGistIsEncrypted(client, gistId);
  if (encrypted) {
    return { ok: false, message: PLAINTEXT_GIST_BLOCKED_MESSAGE };
  }
  return { ok: true };
}
