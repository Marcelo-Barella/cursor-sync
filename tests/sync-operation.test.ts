import { afterEach, describe, expect, it } from "vitest";
import {
  endSyncOperation,
  isSyncOperationActive,
  tryBeginSyncOperation,
} from "../src/sync-operation.js";

describe("sync-operation lock", () => {
  afterEach(() => {
    endSyncOperation();
  });

  it("exposes a single shared lock for push and pull", () => {
    expect(tryBeginSyncOperation()).toBe(true);
    expect(isSyncOperationActive()).toBe(true);
    expect(tryBeginSyncOperation()).toBe(false);
    endSyncOperation();
    expect(isSyncOperationActive()).toBe(false);
    expect(tryBeginSyncOperation()).toBe(true);
    endSyncOperation();
  });
});
