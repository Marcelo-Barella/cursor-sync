import type { SyncManifestMetadataOverrides } from "./sync-manifest.js";

export function parseMetadataOverrides(
  mo: Record<string, unknown>
): { ok: true; overrides: SyncManifestMetadataOverrides } | { ok: false; errors: string[] } {
  let composer_header_payloads: Array<Record<string, unknown>> | undefined;
  const chp = mo.composer_header_payloads;
  if (chp !== undefined) {
    if (!Array.isArray(chp)) {
      return { ok: false, errors: ["metadata_overrides.composer_header_payloads must be array"] };
    }
    composer_header_payloads = [];
    for (let pi = 0; pi < chp.length; pi++) {
      const p = chp[pi];
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        return {
          ok: false,
          errors: [`metadata_overrides.composer_header_payloads[${pi}] must be an object`],
        };
      }
      composer_header_payloads.push(p);
    }
  }

  let state_vscdb_sql: string[] | undefined;
  const sqlRaw = mo.state_vscdb_sql;
  if (sqlRaw !== undefined) {
    if (!Array.isArray(sqlRaw)) {
      return { ok: false, errors: ["metadata_overrides.state_vscdb_sql must be array of strings"] };
    }
    state_vscdb_sql = [];
    for (let si = 0; si < sqlRaw.length; si++) {
      const statement = sqlRaw[si];
      if (typeof statement !== "string") {
        return {
          ok: false,
          errors: [`metadata_overrides.state_vscdb_sql[${si}] must be a string`],
        };
      }
      state_vscdb_sql.push(statement);
    }
  }

  return {
    ok: true,
    overrides: { state_vscdb_sql, composer_header_payloads },
  };
}
