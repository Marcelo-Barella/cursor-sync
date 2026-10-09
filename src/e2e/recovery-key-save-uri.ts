import * as fs from "node:fs";
import * as path from "node:path";
import { nodePlatform } from "../os-runtime.js";
import { resolveEffectiveUserHome } from "../paths.js";

const RECOVERY_KEY_FILE_NAME = "cursor-sync-recovery-key.txt";

export function defaultRecoveryKeySavePath(): string {
  const home = resolveEffectiveUserHome(nodePlatform());
  const downloads = path.join(home, "Downloads");
  try {
    if (fs.existsSync(downloads) && fs.statSync(downloads).isDirectory()) {
      return path.join(downloads, RECOVERY_KEY_FILE_NAME);
    }
  } catch {
  }
  return path.join(home, RECOVERY_KEY_FILE_NAME);
}
