import type * as vscode from "vscode";
import type { GistClient } from "../gist.js";
import { tryReadGistE2eMarker } from "./gist-bundle.js";
import { loadSyncState, saveSyncState } from "../diagnostics.js";

export const PLAINTEXT_GIST_BLOCKED_MESSAGE =
  "This Gist is encrypted with Cursor Sync. Log in and unlock before writing plaintext.";

export const GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE =
  "Couldn't verify gist encryption state. Try again.";

export type GistEncryptionProbeResult =
  | { state: "plain" }
  | { state: "encrypted" }
  | { state: "unknown" };

async function clearStaleGistIdIfDeleted(
  context: vscode.ExtensionContext,
  gistId: string
): Promise<void> {
  const syncState = await loadSyncState(context);
  if (!syncState || syncState.gistId !== gistId) {
    return;
  }
  await saveSyncState(context, {
    ...syncState,
    gistId: "",
  });
}

export async function probeSyncGistEncryption(
  client: GistClient,
  gistId?: string,
  context?: vscode.ExtensionContext
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
    if (gist.error.statusCode === 404 && context && id) {
      await clearStaleGistIdIfDeleted(context, id);
      return { state: "plain" };
    }
    return { state: "unknown" };
  }
  const encrypted = tryReadGistE2eMarker(gist.data.files) !== undefined;
  return encrypted ? { state: "encrypted" } : { state: "plain" };
}

export async function assertPlaintextGistWriteAllowed(
  client: GistClient,
  gistId?: string,
  context?: vscode.ExtensionContext
): Promise<{ ok: true } | { ok: false; message: string }> {
  const probe = await probeSyncGistEncryption(client, gistId, context);
  if (probe.state === "encrypted") {
    return { ok: false, message: PLAINTEXT_GIST_BLOCKED_MESSAGE };
  }
  if (probe.state === "unknown") {
    return { ok: false, message: GIST_ENCRYPTION_STATE_UNKNOWN_MESSAGE };
  }
  return { ok: true };
}
