export const E2E_MAGIC = Buffer.from("CSE1", "ascii");

export const MIN_PASSPHRASE_LENGTH = 12;

export const DEFAULT_ARGON2_PARAMS = {
  m: 64 * 1024 * 1024,
  t: 3,
  p: 1,
} as const;

export const SALT_BYTE_LENGTH = 16;
export const GCM_NONCE_BYTE_LENGTH = 12;
export const DEK_BYTE_LENGTH = 32;

export const AAD_WRAP_PASS_PREFIX = "cursor-sync/wrap/v1|pass|";
export const AAD_WRAP_RECOVERY_PREFIX = "cursor-sync/wrap/v1|recovery|";
export const AAD_OBJECT_PREFIX = "cursor-sync/obj/v1|";
export const HMAC_OBJECT_KEY_PREFIX = "cursor-sync/objkey/v1|";
export const DEK_VERIFIER_MESSAGE = "cursor-sync/dek-verifier/v1";
export const HKDF_RECOVERY_INFO = "cursor-sync/recovery/v1";

export const MANIFEST_SYNC_KEY = "__manifest__";
export const GIST_E2E_MARKER_FILE = "cursor-sync-e2e.json";
export const GIST_E2E_FORMAT = "CSE1";

export const E2E_MIGRATION_STATE_KEY = "cursorSync.e2e.migration.v1";
