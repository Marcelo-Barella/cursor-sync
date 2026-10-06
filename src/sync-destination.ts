export type SyncDestinationId = "github-gist" | "cursor-sync-storage";

export const SYNC_DESTINATION_GIST_LABEL = "GitHub Gist";
export const SYNC_DESTINATION_APP_STORAGE_LABEL = "Cursor Sync storage";

export function syncDestinationLabel(destination: SyncDestinationId): string {
  return destination === "cursor-sync-storage"
    ? SYNC_DESTINATION_APP_STORAGE_LABEL
    : SYNC_DESTINATION_GIST_LABEL;
}

export function formatPushSuccessToast(
  fileCount: number,
  destination: SyncDestinationId,
  options?: { deletedRemotely?: number }
): string {
  const deleted = options?.deletedRemotely ?? 0;
  const noun = fileCount === 1 ? "file" : "files";
  const dest =
    destination === "cursor-sync-storage" ? "Cursor Sync storage" : "GitHub Gist";
  if (deleted > 0) {
    const delNoun = deleted === 1 ? "file" : "files";
    return `Pushed ${fileCount} ${noun} to ${dest} and removed ${deleted} remote ${delNoun}`;
  }
  if (destination === "cursor-sync-storage") {
    return `Pushed ${fileCount} ${noun} to Cursor Sync storage`;
  }
  return `Pushed ${fileCount} ${noun} to GitHub Gist`;
}

export function formatPullSuccessToast(
  fileCount: number,
  destination: SyncDestinationId,
  options?: { wroteFiles?: number; deletedLocally?: number }
): string {
  const wrote = options?.wroteFiles ?? fileCount;
  const deleted = options?.deletedLocally ?? 0;
  if (deleted > 0 && wrote > 0) {
    const parts: string[] = [];
    parts.push(`Pulled ${wrote} ${wrote === 1 ? "file" : "files"}`);
    parts.push(`removed ${deleted} local ${deleted === 1 ? "file" : "files"}`);
    if (destination === "cursor-sync-storage") {
      return `${parts[0]} from Cursor Sync storage and ${parts[1]}`;
    }
    return `${parts[0]} from GitHub Gist and ${parts[1]}`;
  }
  if (deleted > 0 && wrote === 0) {
    const noun = deleted === 1 ? "file" : "files";
    if (destination === "cursor-sync-storage") {
      return `Removed ${deleted} local ${noun} per Cursor Sync storage`;
    }
    return `Removed ${deleted} local ${noun} per GitHub Gist`;
  }
  const noun = fileCount === 1 ? "file" : "files";
  if (destination === "cursor-sync-storage") {
    return `Pulled ${fileCount} ${noun} from Cursor Sync storage`;
  }
  return `Pulled ${fileCount} ${noun} from GitHub Gist`;
}

export function formatPushRemovalToast(
  fileCount: number,
  destination: SyncDestinationId
): string {
  const noun = fileCount === 1 ? "file" : "files";
  if (destination === "cursor-sync-storage") {
    return `Removed ${fileCount} ${noun} from Cursor Sync storage`;
  }
  return `Removed ${fileCount} ${noun} from GitHub Gist`;
}

export function formatPullEmptyToast(destination: SyncDestinationId): string {
  if (destination === "cursor-sync-storage") {
    return "Pulled from Cursor Sync storage: nothing to update";
  }
  return "Pulled from GitHub Gist: nothing to update";
}

export function formatPushPartialToast(
  uploaded: number,
  total: number,
  unreadable: number,
  destination: SyncDestinationId
): string {
  if (destination === "cursor-sync-storage") {
    return `Pushed ${uploaded} of ${total} files to Cursor Sync storage, ${unreadable} unreadable`;
  }
  return `Pushed ${uploaded} of ${total} files to GitHub Gist, ${unreadable} unreadable`;
}

export function formatPullPartialToast(
  pulled: number,
  total: number,
  missing: number,
  destination: SyncDestinationId
): string {
  if (destination === "cursor-sync-storage") {
    return `Pulled ${pulled} of ${total} from Cursor Sync storage, ${missing} missing`;
  }
  return `Pulled ${pulled} of ${total} from GitHub Gist, ${missing} missing`;
}
