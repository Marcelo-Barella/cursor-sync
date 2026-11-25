import { describe, expect, it } from "vitest";
import { deriveStorageSyncPresentation } from "../src/storage-sync-ui-status.js";
import type { SyncHistoryEntry } from "../src/types.js";

function storageEntry(
  partial: Partial<SyncHistoryEntry> & Pick<SyncHistoryEntry, "success">
): SyncHistoryEntry {
  return {
    timestamp: "2026-01-02T00:00:00.000Z",
    direction: "pull",
    trigger: "scheduled",
    fileCount: 0,
    destination: "cursor-sync-storage",
    ...partial,
  };
}

describe("deriveStorageSyncPresentation", () => {
  it("prefers failure over active held fingerprint", () => {
    const history = [
      storageEntry({ success: false, error: "network down" }),
      storageEntry({ success: false, held: true, error: "held: root" }),
    ];
    const p = deriveStorageSyncPresentation({
      history,
      activeHeldFingerprint: "fp",
    });
    expect(p.level).toBe("error");
  });

  it("shows held warning while fingerprint active even after a later push success", () => {
    const history = [
      storageEntry({ success: true, direction: "push", fileCount: 1 }),
      storageEntry({ success: false, held: true, error: "held: root" }),
    ];
    const p = deriveStorageSyncPresentation({
      history,
      activeHeldFingerprint: "fp",
    });
    expect(p.level).toBe("warning");
    expect(p.warningKind).toBe("held");
  });

  it("ignores stale held history after fingerprint cleared", () => {
    const history = [
      storageEntry({ success: true, error: "Recovered — already in sync" }),
      storageEntry({ success: false, held: true, error: "held: root" }),
    ];
    const p = deriveStorageSyncPresentation({
      history,
      activeHeldFingerprint: undefined,
    });
    expect(p.level).toBe("ok");
  });

  it("treats partial pulls as warning not error", () => {
    const history = [
      storageEntry({ success: false, partial: true, fileCount: 2, error: "partial msg" }),
    ];
    const p = deriveStorageSyncPresentation({ history });
    expect(p.level).toBe("warning");
    expect(p.warningKind).toBe("partial");
  });
});
