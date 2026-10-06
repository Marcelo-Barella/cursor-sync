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
| present | untracked | * | noop | safe; excluded/out-of-scope keys prune via baseline_refresh when tracked |
| present | untracked | local gone | baseline_refresh | prune baseline |

## Extensions

| Situation | Local classification | Action |
|-----------|---------------------|--------|
| Parent directory removed (nested ok); strict path walk under realpath root | provably_absent / absent_eligible | pull if remote present; delete_remote only when strict path allows |
| Symlink or non-directory anywhere below sync root on path to key | skipped_unknown | noop; no pull, no delete_remote, no writes outside root |
| Symlinked ancestor (e.g. `rules` → empty dir) | skipped_unknown for all descendants | noop (S1) |
| Symlink pointing outside root (e.g. `skills` → external dir) | skipped_unknown | noop; pull write blocked (S3) |
| Enabled sync root missing on fresh device | — | create root (real parent dir), then pull |
| Remote-only baseline key, absent locally and remotely | provably_absent / absent_eligible | baseline_refresh prune (F6), not recurring pull |
| Key excluded but still in baseline | untracked | baseline_refresh (prune); noop for sync actions on that key |
| Declined pull overwrite (same remote checksum) | present | noop (all triggers) |
| Declined keep-local (same local checksum) | present | noop for delete_local |
| Independent edits on different keys | per key | `pull-push` aggregate |

## Disk classifier (`classifyLocalPath`)

- Resolve each sync root with `realpath` once; `lstat` every component from root to key.
- **ENOENT:** walk ancestors; proven absent only if every existing component is a real directory inside `realpath(root)`.
- **Present file:** regular file, in size limit, `realpath` under root.
- **Otherwise:** `skipped_unknown` (authoritative over scan listing).
- Scan enumeration does not descend into symlink directories (`readdir` + `lstat`).
- Pull: `mkdir` one component at a time with `lstat` checks; verify `realpath(parent)` under root; write without following symlinks.
