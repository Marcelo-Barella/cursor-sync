import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runMetadataSqlOnShadowDb } from "../src/sync-engine-ops.js";
import { UnsafeSqlScriptError } from "../src/sqlite-script-safety.js";

describe("sync manifest SQL safety", () => {
  it("refuses state_vscdb_sql with dot-commands", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-manifest-sql-"));
    const db = path.join(dir, "state.vscdb");
    await fs.writeFile(db, "", "utf8");
    await expect(
      runMetadataSqlOnShadowDb(db, [".shell touch /tmp/evil"])
    ).rejects.toThrow(UnsafeSqlScriptError);
  });

  it("refuses pre_hydrate-style ATTACH", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-manifest-sql-"));
    const db = path.join(dir, "store.db");
    await fs.writeFile(db, "", "utf8");
    const { runSqliteScript } = await import("../src/transcripts-sqlite.js");
    await expect(runSqliteScript(db, "ATTACH '/tmp/x' AS e;")).rejects.toThrow(
      UnsafeSqlScriptError
    );
  });
});
