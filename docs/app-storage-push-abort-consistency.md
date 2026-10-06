# App storage push abort and R2/manifest consistency

When an app configs **push** is cancelled (including logout while a push is in flight), Cursor Sync keeps the remote manifest aligned with objects already stored in R2.

## Strategy

1. Upload file bytes to R2 one key at a time, checking the operation abort signal before each upload.
2. If the push stops before all local files are uploaded, **commit a metadata-only manifest for the keys that were uploaded successfully** via `PUT /configs`.
3. Keys that were not uploaded in that run are left unchanged in R2 and remain represented only by the previous manifest (if any).

This avoids orphan objects that are not referenced by the manifest checksums, and avoids overwriting existing object keys until the corresponding manifest entry is committed.

## Logout

Logout aborts the in-flight push, waits for it to finish (bounded timeout), then clears the local session. The push finalizer runs the partial manifest commit when at least one object was uploaded in that attempt.
