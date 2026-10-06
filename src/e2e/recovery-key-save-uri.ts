import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RECOVERY_KEY_FILE_NAME = "cursor-sync-recovery-key.txt";

export function defaultRecoveryKeySavePath(): string {
  const home = os.homedir();
  const downloads = path.join(home, "Downloads");
  try {
    if (fs.existsSync(downloads) && fs.statSync(downloads).isDirectory()) {
      return path.join(downloads, RECOVERY_KEY_FILE_NAME);
    }
  } catch {
  }
  return path.join(home, RECOVERY_KEY_FILE_NAME);
}
