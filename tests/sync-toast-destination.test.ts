import { describe, expect, it } from "vitest";
import {
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
});
