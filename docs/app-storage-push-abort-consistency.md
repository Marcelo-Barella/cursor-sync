# App storage push abort and R2/manifest consistency

The app configs API **replaces** the entire config list on `PUT /configs`; it does not merge. Cursor Sync must never send a shrunken manifest after a partial upload.

## Strategy

1. Before push, fetch the current remote payload (metadata-only) as the baseline.
2. Upload file bytes to R2 one key at a time, honoring the operation abort signal.
3. On a normal completion, `PUT` the full local manifest metadata.
4. On abort (including logout), `PUT` a manifest built from the **remote baseline**, updating metadata entries only for keys that were uploaded successfully in this attempt. All other keys stay exactly as on the server.
5. Config `PUT` uses a timeout and the same abort signal as the push operation.

If the metadata `PUT` fails after objects were uploaded, the extension sets a durable `remoteDirty` flag in global state so the next push or pull reconciles before proceeding.

## Pull integrity

Downloads verify each object's checksum against the manifest before writing. Mismatched objects are skipped (never written).

Pull writes use a journal, unique backup names, unique temp files (`O_EXCL`), symlink-aware backup/restore, path containment checks, and rollback that preserves user edits made mid-pull.
