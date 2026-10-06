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
  destination: SyncDestinationId
): string {
  const noun = fileCount === 1 ? "file" : "files";
  if (destination === "cursor-sync-storage") {
    return `Pushed ${fileCount} ${noun} to Cursor Sync storage`;
  }
  return `Pushed ${fileCount} ${noun} to GitHub Gist`;
}

export function formatPullSuccessToast(
  fileCount: number,
  destination: SyncDestinationId
): string {
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
