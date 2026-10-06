import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { defaultRecoveryKeySavePath } from "../src/e2e/recovery-key-save-uri.js";

describe("defaultRecoveryKeySavePath", () => {
  it("uses home or Downloads, not filesystem root", () => {
    const filePath = defaultRecoveryKeySavePath();
    expect(filePath).toContain("cursor-sync-recovery-key.txt");
    expect(filePath.startsWith("/cursor-sync")).toBe(false);
    const home = os.homedir();
    const downloads = path.join(home, "Downloads", "cursor-sync-recovery-key.txt");
    const inHome = path.join(home, "cursor-sync-recovery-key.txt");
    expect([downloads, inHome]).toContain(filePath);
  });
});
