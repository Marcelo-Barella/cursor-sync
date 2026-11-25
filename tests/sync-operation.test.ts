import { afterEach, describe, expect, it } from "vitest";
import {
  isSyncOperationActive,
  resetSyncOperation,
  tryBeginSyncOperation,
} from "../src/sync-operation.js";

describe("sync-operation lock", () => {
  afterEach(() => {
    resetSyncOperation();
  });

  it("tracks a single shared sync operation latch", () => {
    expect(tryBeginSyncOperation()).toBe(true);
    expect(isSyncOperationActive()).toBe(true);
    expect(tryBeginSyncOperation()).toBe(false);
    resetSyncOperation();
    expect(isSyncOperationActive()).toBe(false);
    expect(tryBeginSyncOperation()).toBe(true);
    resetSyncOperation();
  });
});
