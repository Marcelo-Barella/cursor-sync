import { describe, expect, it } from "vitest";
import {
  formatPullSuccessToast,
  formatPushSuccessToast,
  SYNC_DESTINATION_APP_STORAGE_LABEL,
  SYNC_DESTINATION_GIST_LABEL,
  syncDestinationLabel,
} from "../src/sync-destination.js";

describe("sync destination labels", () => {
  it("names GitHub Gist and Cursor Sync storage for toasts", () => {
    expect(syncDestinationLabel("github-gist")).toBe(SYNC_DESTINATION_GIST_LABEL);
    expect(syncDestinationLabel("cursor-sync-storage")).toBe(
      SYNC_DESTINATION_APP_STORAGE_LABEL
    );
    expect(SYNC_DESTINATION_GIST_LABEL).toBe("GitHub Gist");
    expect(SYNC_DESTINATION_APP_STORAGE_LABEL).toBe("Cursor Sync storage");
  });

  it("uses short success toasts for storage", () => {
    expect(formatPushSuccessToast(4, "cursor-sync-storage")).toBe(
      "Pushed 4 files to Cursor Sync storage"
    );
    expect(
      formatPushSuccessToast(1, "cursor-sync-storage", { deletedRemotely: 1 })
    ).toBe(
      "Pushed 1 file to Cursor Sync storage and removed 1 remote file"
    );
    expect(formatPullSuccessToast(1, "cursor-sync-storage")).toBe(
      "Pulled 1 file from Cursor Sync storage"
    );
  });
});
