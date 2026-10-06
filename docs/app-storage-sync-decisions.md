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
| present | untracked | local gone | baseline_refresh | prune baseline |

## Extensions

| Situation | Local classification | Action |
|-----------|---------------------|--------|
| Parent directory removed (one or nested levels); ancestor walk proves path under enabled root | provably_absent / absent_eligible | pull if remote present; delete_remote if local gone and remote unchanged |
| Key excluded or out of scope but still in baseline (e.g. moved under `excludeGlobs`) | untracked | baseline_refresh (prune); never pull overwrite or delete_local on out-of-scope disk |
| Declined pull overwrite (checksum unchanged) | present | noop (all triggers) |
| Declined keep-local against remote delete | present | noop for delete_local |
| Independent edits on different keys | per key | push on changed-local keys, pull on changed-remote keys (`pull-push` aggregate, not global conflict) |

## Disk probe (`classifyLocalPath`)

- **ENOENT:** walk to nearest existing ancestor; readable real directory under enabled non-excluded root → `proven_absent`; else `skipped_unknown`.
- **Regular in-scope file within size limit:** `present`.
- **Excluded, oversize, symlink, non-regular, unreadable:** `skipped_unknown`.
- Never downgrade scan `provably_absent` when classification is not `present`.

Pull writes create missing parent directories with `mkdirParentsWithoutSymlinks` (no traversal through symlinks).
