# App storage sync decision table

Canonical reference for per-key sync classification (implementation: `decideSyncKey` in `src/app-storage-sync-decisions.ts`).

## Dimensions

- **Baseline:** absent | present (key tracked in baseline store)
- **Local:** present | provably_absent | absent_eligible (disk-proven) | skipped_unknown | untracked
- **Remote:** absent | present_same | present_changed

## Actions

`push` | `pull` | `delete_remote` | `delete_local` | `conflict` | `noop` | `baseline_refresh`

`pullPreselected` applies when action is `pull` (manual overwrite picker default).

## Core table

| Baseline | Local | Remote | Action | Pull preselected |
|----------|-------|--------|--------|------------------|
| absent | present | absent | push | n/a |
| absent | present | present_same | baseline_refresh | n/a |
| absent | present | present_changed | conflict | false |
| absent | absent_eligible / provably_absent | present_* | pull | true |
| absent | provably_absent | absent | noop | n/a |
| absent | skipped / untracked | present_* | noop | false |
| present | present | present_same | noop | n/a |
| present | present | present_changed | pull | true |
| present | present | absent | delete_local | n/a (threshold + dialog) |
| present | provably_absent | absent | baseline_refresh | n/a |
| present | provably_absent | present_same | delete_remote | n/a |
| present | provably_absent | present_changed | conflict | false |
| present | skipped_unknown | * | noop | false |
| present | untracked | * | noop | excluded/out-of-scope keys noop for sync actions |
| present | untracked | local gone | noop | baseline may refresh separately; no sync delete |

## Extensions

| Situation | Local classification | Action |
|-----------|---------------------|--------|
| Parent directory removed (nested ok); strict path walk under realpath root | provably_absent / absent_eligible | pull if remote present; delete_remote only when strict path allows |
| Symlink or non-directory anywhere below sync root on path to key | skipped_unknown | noop; no pull, no delete_remote, no writes outside root |
| Symlinked ancestor (e.g. `rules` → empty dir) | skipped_unknown for all descendants | noop (S1) |
| Symlink pointing outside root (e.g. `skills` → external dir) | skipped_unknown | noop; pull write blocked (S3) |
| Sync root missing with baseline entries | skipped_unknown for all keys under root | noop; deletes held; Sync Now shows root missing/empty notice (not per-file unsafe) |
| Sync root missing without baseline (fresh device) | absent_eligible / provably_absent | pull allowed; create root only at write time (never during scan) |
| Every tracked file under a root missing on disk (per-root hold) | skipped_unknown under that root | noop; deletes held both directions; Sync Now shows held-root notice |
| Sync root cannot be created (dangling root symlink, b12) | keys under that root | pull skips those keys only; other roots still sync; warning names the root |
| Sync root parent not a real directory (b16) | keys under that root | same partial pull as b12 |
| Symlinked sync root (`realpath` once) | absent_eligible under resolved empty target | pull allowed; walk/classify below resolved root; symlink at root is not skipped_unknown |
| Remote-only baseline key, absent locally and remotely | provably_absent / absent_eligible | baseline_refresh prune (F6), not recurring pull |
| Key excluded but still in baseline | untracked | noop for sync actions on that key |
| Declined pull overwrite (same remote checksum) | present | noop (all triggers) |
| Declined keep-local (same local checksum) | present | noop for delete_local |
| Independent edits on different keys | per key | `pull-push` aggregate |

## Disk classifier (`classifyLocalPath`)

- Resolve each sync root with `realpath` once; `lstat` every component from root to key.
- **ENOENT:** walk ancestors; proven absent only if every existing component is a real directory inside `realpath(root)`.
- **Present file:** regular file, in size limit, `realpath` under root.
- **Otherwise:** `skipped_unknown` (authoritative over scan listing).
- Scan enumeration does not descend into symlink directories (`readdir` + `lstat`).
- Pull: `mkdir` one component at a time with `lstat` checks; verify `realpath(parent)` under root; write via random tmp in the verified parent using `O_CREAT|O_EXCL|O_NOFOLLOW` (`wx` + `O_NOFOLLOW`), fsync, re-verify parent chain, then rename onto the target.
- **Unreadable file** (exists but not readable): `skipped_unknown`; Sync Now held as unreadable, not “already in sync”.

## Subprocess allowlist (`src/os-runtime.ts`)

Only these executables may be spawned via `execFileAsync`, `spawnSyncCapture`, or `spawnPython3Capture`:

`python3`, `python`, `python3.N` (e.g. `python3.12`), `py`, `sqlite3`, `chmod`

Commands are resolved to an absolute path on `PATH` from a minimal parent env (never cwd-relative). Caller options cannot override `shell`, `env`, or `argv0`; `shell` is always false. Child `env` is built from an allowlist only: `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot`, `windir`, `COMSPEC`, `PATHEXT`, `SYSTEMDRIVE` (each justified in source).

`sqlite3` CLI is used only for `-safe` JSON queries (`runSqliteQuery`). Multi-statement scripts use Python `sqlite3.executescript` on stdin with `enable_load_extension(False)` after `assertSafeSqlScript` (no `.read`, no unsafe CLI fallback). Manifest `pre_hydrate_sql` and `state_vscdb_sql` go through the same path.

`cursorSync.chatImport.pythonPath` is **machine** scope only (workspace overrides ignored).

### Known subprocess residuals (documented, not fully blockable)

- Python `os.path.expanduser`, `pwd`, `getent passwd`, reading `/etc/passwd` inside allowlisted interpreters.
- Any behavior of the resolved `python3` / `sqlite3` binary itself once spawned.

## AST / bundle guards

- All `src/**` sources except `paths.ts` and `os-runtime.ts` are scanned for free-reference forbidden identifiers, banned runtime imports, non-literal `import()`/`require`, imports resolving outside `src/`, home-path string literals (via `paths.ts` user labels), `/proc/` / `environ` literals, top-level `arguments`, and `systemTmpDir()` traversal patterns.
- Bundle metafile guard matches AST banned modules (`worker_threads`, `inspector`, `v8`, `cluster`, …).
- `paths.ts` is allowlisted because it resolves Cursor user paths via `node:os` / `process.env` (platform-specific layout only).
- `os-runtime.ts` is the sole gateway for `child_process` and host identity helpers.
