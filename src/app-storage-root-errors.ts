export function formatSyncRootEnsureUserMessage(raw: string): string {
  const codeMatch = /\b(EEXIST|EACCES|EPERM|ENOTDIR|EROFS|ENOSPC)\b/.exec(raw);
  const code = codeMatch?.[1];
  if (code === "EEXIST") {
    return "Couldn't create the sync folder: a file with that name already exists.";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Couldn't create the sync folder: permission denied.";
  }
  if (code === "ENOTDIR") {
    return "Couldn't create the sync folder: the parent path isn't a folder.";
  }
  if (code === "EROFS") {
    return "Couldn't create the sync folder: the filesystem is read-only.";
  }
  if (code === "ENOSPC") {
    return "Couldn't create the sync folder: disk is full.";
  }
  if (raw.trim()) {
    return `Couldn't create the sync folder: ${raw.trim()}`;
  }
  return "Couldn't create the sync folder.";
}

export function pullWriteSkipReasonFromError(err: unknown): import("./app-storage-delete-guard.js").PerFileHeldReason {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return "permission_denied";
  }
  if (code === "ENOSPC") {
    return "disk_full";
  }
  if (code === "EROFS") {
    return "read_only_fs";
  }
  return "write_failed";
}
