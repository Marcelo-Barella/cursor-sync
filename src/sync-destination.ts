export type SyncDestinationId = "github-gist" | "cursor-sync-storage";

export const SYNC_DESTINATION_GIST_LABEL = "GitHub Gist";
export const SYNC_DESTINATION_APP_STORAGE_LABEL = "Cursor Sync storage";

export function syncDestinationLabel(destination: SyncDestinationId): string {
  return destination === "cursor-sync-storage"
    ? SYNC_DESTINATION_APP_STORAGE_LABEL
    : SYNC_DESTINATION_GIST_LABEL;
}
