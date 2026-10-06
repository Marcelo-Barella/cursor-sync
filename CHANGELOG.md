# Changelog

## [Unreleased]

## v0.8.4-staging.30

### Fixed
- App storage: excluded/oversize keys no longer enter `untracked` or `baseline_refresh`, so peer deletes are not undone when exclude/size limits toggle; empty-scan hold runs before baseline refresh when all tracked files are out of scope.
- UX: single root-ensure warning on pull; scheduled root-held markers clear on clean ticks; scheduled pull history summarizes file count; manual pull shows up to date when nothing changes; never-synced symlink skip labels deduped; TOCTOU pull writes labeled changed during write.
- SQL transport: preserve UTF-8 emoji/ZWJ/CJK in `runSqliteScript` (no surrogate-pair stripping).

## v0.8.4-staging.29

### Fixed
- SQL safety: single-pass lexer tokenizes comments and quoted regions together (quotes inside `--`/`/* */` no longer desync masking); Python `executescript` runner adds `set_authorizer`, `SQLITE_LIMIT_ATTACHED` when available, and per-statement refusal of ATTACH/DETACH/VACUUM and forbidden functions.

## v0.8.4-staging.28

### Fixed
- App storage UX: disk probe carries excluded/oversize/symlink-folder reasons on fresh devices; pull partial toasts count skipped files with per-file reasons; remote-update-held only when checksum differs; manual pull always warns on root ensure failures; scheduled sync handles `blocked` with deduped held history; scheduled UI suppression limited to root-only holds.

## v0.8.4-staging.27

### Fixed
- SQL safety: mask string/blob/quoted identifiers before comment stripping and statement splitting so chat titles and message bodies with `;`, `attach`, `VACUUM`, etc. still sync; strip comments without joining tokens for keyword scans; reject NUL in `escapeSqlLiteral`.
- Bundle guard: allow `node_modules` only for declared runtime dependencies and their transitive names from each package's `package.json` (not `require.resolve` hoisting tricks).

## v0.8.4-staging.26

### Fixed
- SQL manifest safety: normalize scripts (strip Unicode Cf, collapse comments/whitespace), statement allowlist, block VACUUM/ATTACH/file functions; bundle guard checks every metafile input realpath (src or declared runtime `node_modules` without symlink escape); build/package run tsc + bundle meta + AST/bundle probe tests; AST allow `import { process as p }` and literal `environs`; absolute Python only via configured `chatImport.pythonPath`.

## v0.8.4-staging.25

### Fixed
- App storage UX: per-reason held labels (unreadable, excluded, oversize, symlink); manual pull warns on held remote updates; push skip labels use baseline/remote tracking; warning toasts when skips are not only never-synced symlinks; scheduled pull stays silent on root-held with deduped held history; Sync Now recreation after delete confirm is informational, not a failed push.

## v0.8.4-staging.24

### Fixed
- SQLite scripts: Python `executescript` with `enable_load_extension(False)`; no `.read` or unsafe `-safe` bypass; manifest SQL validated (dot-commands, ATTACH, load_extension, PRAGMA allowlist).
- `SubprocessCommandNotFoundError` (ENOENT) restores Python fallback when `sqlite3` is missing on PATH.
- Bundle guard: metafile inputs must `realpath` under `src/`; AST lexical scope for forbidden identifiers; expanded home-path rules; PATH skips relative/empty entries.

## v0.8.4-staging.23

### Fixed
- `os-runtime`: allowlisted env only; PATH-resolved absolute executables; no caller `shell`/`env`; `sqlite3 -safe`; `python3.N` + machine-scoped `chatImport.pythonPath`.
- AST guard: non-literal dynamic import; outside-`src/` imports; home-path literals via `paths` labels; free-identifier matching; metafile scan; bundle ban parity.
- Esbuild: remove stale `extension.meta.json` on guard failure; watch mode keeps watching.
- Scheduled push re-checks provably-absent explicit deletions (M17).
- `npm test` typechecks all `tests/**` (`tsconfig.test.json`).

## v0.8.4-staging.22

### Fixed
- AST guard: identifier ban (`require`, `process`, `global`, `globalThis`, `eval`, `Function`, `Reflect`, `module`), any `.constructor` access, expanded banned imports, `/proc/`/`environ` literals, `systemTmpDir()`+`..` traversal; scans all `src/**` sources; Tester probe fixtures.
- Subprocess allowlist + scrubbed env in `os-runtime.ts` (`python3`, `python`, `py`, `sqlite3`, `chmod` only).
- Esbuild writes bundle to a temp file and renames only after metafile guard passes; `ctx.dispose()` in `finally`.
- Disk probe: unreadable files (e.g. chmod 000) are not “present”; root-held notice wins over per-file held; categorized held messages; manual pull held notice; manual push single toast with never-synced symlink labeling; local disk keys in push skip probe; Sync Now re-checks provably-absent for explicit deletions.
- Root-creation pull warning once per session (including scheduled).

### Changed
- `npm test` typechecks `tests/` via `tsconfig.test.json`.
- Decision table: root-held vs per-file messaging; subprocess allowlist documentation.

## v0.8.4-staging.21

### Fixed
- `npm test` runs `tsc --noEmit` before build/tests so bundle/type errors cannot ship.
- Esbuild metafile guard iterates `imports[].path`, checks all bundled inputs (including outside `src/`), and runs on watch rebuilds.
- Manual push skip notice uses disk-probe classification over baseline, remote manifest, and on-disk keys (F3); integration test uses a real symlink on disk.
- Pull creates missing sync roots before `realpath` resolution (b14); root creation failure skips only that root’s keys (b12/b16).
- AST guard expanded (finite deny-list): `globalThis`/`eval`/`Function`/`Reflect`/`module`/`vm`, strict `require`, `.constructor.constructor`, `createRequire`, `.jsx`, and metafile-scoped sources.
- Sync Now shows per-file held notice when paths are `skipped_unknown`; manual pull warns on empty remote manifest.

### Changed
- Decision table: per-root delete hold and b12/b16 root-creation failure rows.

## v0.8.4-staging.20

### Fixed
- Fresh device: missing `~/.cursor` without baseline classifies as `absent_eligible` (pull allowed); root created only at write time. Baseline + missing/empty root stays `skipped_unknown`.
- Symlinked empty sync root: classify below `realpath(root)` so new keys under the root can pull (b13 / N3b3).
- Manual push shows classification-based skip notice (`Pushed N, skipped M`); disk probe no longer downgrades held roots to `proven_absent`.
- Pull: per-key write failure skips with notice (no full rollback); tmp unlink only after successful `open`.
- Sync Now / Pull show held-root notice when deletes are blocked (S3).

### Changed
- Two-layer path guard: expanded AST over all `src` sources + esbuild metafile bundle check; spawn env confined to `os-runtime.ts`.
- Decision table rows for fresh-device pull and symlinked root.

## v0.8.4-staging.19

### Fixed
- **P0 / case g:** Scan no longer creates missing sync roots; baseline + missing/empty root marks all keys under that root `skipped_unknown` and blocks deletes (inclusive 50% threshold and per-root all-absent guard).
- Safe pull writes use random `O_EXCL|O_NOFOLLOW` temp files; local deletes re-check `lstat` + `realpath` before each `unlink`/`rmdir`.
- Symlinked sync roots enumerate via `realpath`; fresh-device pull creates roots only when baseline has no keys under that root.
- Refused/skipped pull keys excluded from pulled counts and baseline updates; push skip notice uses classification skips (`Pushed N, skipped M`).
- Scheduler mass-delete block set recomputed each action evaluation; cleared when deletes no longer blocked (F4).

### Changed
- Decision table and hardcoded-path guard updated (`docs/app-storage-sync-decisions.md`, AST check in `tests/hardcoded-sync-paths.test.ts`).

## v0.8.4-staging.18

### Fixed
- Symlink safety (F1/F2): strict `classifyLocalPath` with `realpath` roots and per-component `lstat`; no delete_remote through symlinked dirs; pull writes cannot escape sync root.
- Scan does not list through symlink directories; removed provably_absent downgrade override.
- Push skip toast includes symlink/skipped_unknown keys (F3); mass-delete dedupe resets on scheduler none when block set changes (F4).
- Declines keyed to remote checksum for pull; keep-local expires on local checksum change or explicit push (F5).
- Remote-only orphan baseline keys prune via baseline_refresh (F6); pull-push threshold-held deletes show warning not upload failure (F7).
- Missing enabled sync roots are created on fresh devices before pull.

### Changed
- Decision table doc: excluded keys noop, symlink/missing-root/F6 rows (`docs/app-storage-sync-decisions.md`).
- Hardcoded-path guard: structural rule (only `paths.ts` may import `os` or read `process.env`).

## v0.8.4-staging.17

### Fixed
- Unified `classifyLocalPath` for decision and pull paths: missing parent dirs are `proven_absent` (ancestor walk); scan `provably_absent` is never downgraded (K26, K27).
- Pull creates parent dirs via `mkdirParentsWithoutSymlinks`; manual pull skips generated `extensions.json`.
- Declines feed `decideSyncKey` so scheduler/Sync Now respect declined overwrites and keep-local deletes (K28).
- Per-key `pull-push` when different keys changed locally vs remotely (K29).
- Excluded-but-tracked keys baseline-prune without blocking other keys; scope mismatch no longer blocks all deletes (K25).
- Mass-delete warning dedupe resets when the blocked deletion set changes, including shrink after restore (K24).

### Changed
- Canonical decision table lives in `docs/app-storage-sync-decisions.md` (not source comments).
- Manual push toasts unreadable/symlink skips; hardcoded-path guard patterns extended.

## v0.8.4-staging.16

### Fixed
- Pull eligibility is proven per key via `lstat` (`absent_eligible` never inferred); excluded/oversize/symlink on disk stay `skipped_unknown`.
- Symlink/non-regular keys are noop in both directions and no longer block pushes or force false conflicts.
- Delete guard uses user-content enumeration only (ignores generated `extensions.json`); m2 empty-scan deletes blocked.
- Nested directory deletes mark all tracked descendants provably absent (walk ancestors on readdir failure).
- Declined pull/delete decisions block resurrection on push until checksum changes or explicit Push/Sync Now; declines store checksums.
- Mass-delete dedupe resets after successful pull/push; exclude-glob scope updates via baseline_refresh before "already in sync".
- `delete_local` requires `wasLocal`; empty-remote Sync Now shows warning only; hashed backup index unchanged.
- Pull removes empty parent dirs after deletes; decision table doc updated (cells U1, N3, B8, B11, m2).

## v0.8.4-staging.15

### Fixed
- Single sync decision table (`app-storage-sync-decisions.ts`) drives classify, scheduler filter, pull preselection, and tests.
- Push delete batch returns a copied array (`resolveMassDeleteBatch`); delete-only push succeeds again.
- Pull absent-local rule: safe absent under enabled roots without baseline provably-absent mark; scheduler auto-pulls tracked remote edits.
- Directory-delete keys are provably absent only (not skipped); mutually exclusive scan states.
- No-baseline local≠remote is conflict and not pull-preselected; pull writes honor scan skip/untracked/symlink via `shouldAllowPullWriteForKey`.
- Declined pull overwrites are not re-uploaded on the next push; empty remote manifest refuses local deletes with warning/history.
- Mass-delete and conflict scheduler warnings dedupe by signature and reset when resolved.
- All-missing storage pull reports failure + history; backup files use hashed names (long paths).

## v0.8.4-staging.14

### Fixed
- Mass-delete threshold uses OR logic (`> 3` or `> 50%` of tracked, plus delete-all-tracked); table-driven coverage for edge ratios.
- Mass-delete guard on push and pull (Sync Now / manual), not only the scheduler; empty remote manifest cannot wipe local tracked files without confirmation.
- Pull overwrite picker: baseline-tracked remote changes pre-selected; no-baseline local≠remote stays unselected (conflict).
- Auto-pull and scheduled pull skip excluded, oversize, symlink, and unreadable on-disk files; only provably absent locals are pull candidates.
- Pull aborts when pre-write backup fails instead of overwriting without a backup.
- Removed directory trees mark descendant baseline keys provably absent so deletes sync.
- Prune baseline entries for untracked keys when paths leave enabled scope; cancel mass-delete / empty picker is a no-op without failure history or “no files uploaded” toast.
- Scheduler mass-delete blocks dedupe warn/history per distinct reason; path guard patterns extended (`userInfo` from `os`, `nodeOs.homedir`, `os["homedir"]`, destructured homedir alias, `USERPROFILE`).

## v0.8.4-staging.13

### Fixed
- **P0 mass delete:** baseline keys are classified as present, provably absent, skipped/unknown, or untracked (config/size). Only provably absent keys may be deleted remotely; empty or untrusted scans block all deletes.
- Mass-delete guard: scheduler never applies large delete batches; manual runs require a modal above 3 files or 50% of tracked keys.
- Safe-mode remote/local delete pickers default to nothing selected; remote delete picker copy updated.
- Reset clears app-storage baselines when paths/limits are reset.
- No-baseline keys absent locally auto-pull on schedule and are pre-selected on manual pull; local present + different remains conflict.
- `/configs` 5xx records a single history entry on Sync Now, scheduler, push, and pull (no duplicate outer catch).

### Changed
- Path guard patterns extended (`os` homedir import, `userInfo`, `process.env["HOME"]`); mixed pull+delete toast mentions both.

## v0.8.4-staging.12

### Fixed
- No-baseline local≠remote is a **conflict** again (no silent first-sync overwrite); scheduled sync never auto-pulls keys without a baseline entry.
- Safe-mode pull overwrite picker leaves keys without a baseline **unselected** (Enter does not overwrite).
- Real local deletes propagate when a baseline key is missing from the scan and not unreadable (deleted files no longer require `enoentKeys` race).
- Pull updates baseline for every reconciled manifest key, including identical files skipped on disk.
- Mutual delete clears baseline without requiring `enoentKeys`; re-adding the same file is a push, not a remote delete.

### Changed
- Pull/delete toasts distinguish local removals from file pulls; push partial toast only when uploads were attempted.
- `fetch` `/configs` 5xx records a storage history entry; path guard covers `node:os`, named `homedir` imports, and `os.userInfo().homedir`.
- Status bar **Setup** (no Gist token) opens app login; symlinks/directories count as unreadable in local scan.

## v0.8.4-staging.11

### Fixed
- Unreadable or non-ENOENT missing files are never treated as local deletes; unreadable keys are excluded from push, delete, and baseline updates with partial push reporting.
- Remote deletions apply on pull even when no file keys are pulled; mutual local+remote delete clears baseline without a permanent conflict.
- Push order is uploads, manifest PUT, then R2 deletes; failed uploads skip deletes and manifest drops.
- Pull reports partial success when manifest keys are missing from storage (404).
- Generated-only empty `extensions.json` on a fresh machine no longer false-conflicts on remote-only settings changes.
- v1 baseline migrates only when attributable to the current session account; foreign v1 baselines are discarded.
- Sync Now / scheduled 401 records history with trigger and "Session expired, log in again"; conflicts record history and show status-bar conflict state.
- Login always opens the paste-code input when openExternal or clipboard fails; **Log out** clears session and keeps per-account baselines; reset preserves `schedule.enabled`.

### Changed
- Hardcoded sync-path guard covers `.config/Cursor/User` joins, `process.env.HOME`, and `require("os").homedir()`.

## v0.8.4-staging.10

### Fixed
- App storage baseline is keyed by server `userId` and API base URL (multi-account store in `globalStorage/app-storage-baseline.json`); legacy single-file baselines migrate on load.
- Remote-only sync no longer false-conflicts on generated `extensions.json`; remote file deletes apply locally on pull (safe-mode confirm); delete-only push updates manifest/R2 and shows a removal toast.
- Push cancel on safe-mode delete picker shows an info toast; storage 401 on push records a single push failure; status bar shows error after a failed storage sync.
- Login: if the browser cannot open, copy the sign-in URL to the clipboard, warn with **Copy URL**, and still open the paste-code input; successful login no longer auto-opens the Output panel.
- Chat/transcript/activation paths use `resolveExtensionSyncRoots` / `CURSOR_DOT_DIR` consistently; hardcoded home-path guard tightened.

### Changed
- Paste-code prompt runs before sync-latch release so login is not blocked by status-bar refresh.

## v0.8.4-staging.9

### Fixed
- App storage sync uses a persisted per-account baseline (`globalStorage/app-storage-baseline.json`) so **Sync Now** / scheduler push local edits instead of pull-then-push overwrites; conflicts are surfaced, never auto-resolved on schedule.
- Storage **Pull** skips files whose local checksum already matches the remote manifest; safe-mode picker lists only differing files.
- Storage push merges `/configs` with the remote manifest (no wiping remote keys); generated-only `extensions.json` (`[]`) counts as zero files for empty-profile guard.
- Status bar shows **Sync: Storage** with last storage sync detail when logged in; refreshes on login, logout, and sync.
- Login opens the paste-code input automatically after launching the browser.
- 401 history entries record the real trigger (`manual`, `syncNow`, `scheduled`, `startup`); 503 text uses **Cursor Sync storage** naming.
- Sidebar **Export** / **Import** moved under a **GitHub Gist** section separate from storage Push/Pull.

### Changed
- Chat/transcript path resolution uses extension `globalStorageUri` (and `CURSOR_DOT_DIR`) via `resolveExtensionSyncRoots`; workspace storage roots derive from the same User dir.

## v0.8.4-staging.8

### Fixed
- Sync enumeration uses the Cursor **User** dir from `globalStorageUri` everywhere settings are packaged or written (Gist push, app storage, scheduler, conflicts, import/export).
- App storage push skips unreadable files, logs real R2 HTTP status, fails partial uploads without updating `/configs` (R2 bytes may be newer until a full push succeeds).
- **Sync Now** and scheduled sync use app storage when logged in; palette Push/Pull/Sync enable with Gist token or app session.
- **Show Status** shows the latest storage attempt including failures, with local-formatted timestamps.
- Sidebar status card reflects Cursor Sync storage history when logged in; redundant **Push storage** / **Pull storage** buttons removed (main Push/Pull route to storage).
- Shorter Push/Pull toasts; storage safe-mode picker title uses **Cursor Sync storage** naming.

### Changed
- Staging developer preset API/website URLs now point at `api-staging.cursor-sync.com` and `staging.cursor-sync.com`; legacy bergamota staging hosts remain available via the **custom** preset.

## v0.8.4-staging.7

### Fixed
- Sidebar **Push** / **Pull** route to Cursor Sync storage when an app session is active; dedicated **Push storage** / **Pull storage** actions when logged in.
- Sync toasts and **Show Status** name the destination (GitHub Gist vs Cursor Sync storage); app-storage push counts only successful R2 uploads and logs each key to the Output channel.
- Sync roots derive the Cursor **User** directory from `globalStorageUri` (supports `--user-data-dir`); `skills-cursor` is excluded from default sync paths.

## v0.8.4-staging.5

### Fixed
- Sidebar **Account** pane refreshes immediately after app login (paste **Enter Login Code** and protocol callback); logged-in state no longer requires Reload Window.

## v0.8.4

### Added
- **App configs R2 storage**: after app login, mint scoped temporary R2 credentials via `POST /v1/storage/credentials` and read/write config file bytes with SigV4 (`aws4fetch`, session token, region `auto`).

### Changed
- **Push App Configs** uploads file bytes to R2 under the scoped user prefix; `PUT /configs` stores schemaVersion, manifest, and per-file metadata only (checksum, size, encoding).
- **Pull App Configs** downloads file bytes from R2; legacy payloads that still include `files[].content` are used as a fallback when an object is missing.

## v0.8.3

### Added
- **App configs sync**: `cursorSync.pullAppConfigs` and `cursorSync.pushAppConfigs` GET/PUT `/configs` on the Cursor Sync app API using the app session JWT (`Authorization: Bearer`).
- App configs payload mirrors Gist sync shape (`schemaVersion: 1`, `manifest`, `files`).

### Changed
- Scheduled sync and **Sync Now** skip Gist push when an app session JWT is present (in-memory or SecretStorage); use app config commands instead.

## v0.8.0

### Added
- **Inline chat activation** via `composer.createNew` with disk-hydrated `partialState` when the manifest is empty (`enrichManifestPartialStateFromDisk`, `partialStateForCreateNewCommand`).
- **`repairComposerDataAfterActivation`** re-persists hydrated `conversationMap`, headers, `conversationState`, encryption keys, and `status: completed` when the IDE clobbers `composerData` after activation.
- **`chat-import-disk-probe.ts`**: shared post-import and post-reload Composer sidebar disk probes (global and workspace `state.vscdb`).
- **Composer export titles** from `composer.composerHeaders` / `allComposers[].name` via `resolveComposerConversationTitle` (snapshot header name wins over transcript snippet).
- **`clearSessionBindingInTree`**: strips `requestId`, `workspaceUris`, and session-only fields from imported composer records and partial state.
- **`readRichComposerDataEntryFromStateDb`** and **`applyRichComposerEntryToPartialState`** for protobuf-backed conversation hydration before `createNew`.
- Tests: `chat-bundle-title.test.ts`; expanded activation, merge, partial-state, and gist-import coverage.

### Changed
- Import rebind stamps destination `workspaceIdentifier` and fresh timestamps on sidebar headers and `composerData` blobs (`rebindComposerRecord`).
- `headersPayloadForImport` preserves snapshot `name` when non-empty instead of overwriting with `bundle.title`.
- Activation partial state keeps destination `workspaceIdentifier`, header `name`, and timestamps after rich disk hydration.
- Post-import UX records last-import probe ids in `globalState` and probes disk state before optional reload; extension activate replays probe after pending sidebar writeback flush.
- Python disk import: `persist_disk_kv_rows_to_db` with integrity-check skip path; optional purge gate for `cursorDiskKV` rows.
- `chat-persistence-restore.ts` delegates sidebar disk probing to the shared probe module.

### Fixed
- Empty `partialState` passed to `composer.createNew` no longer wipes disk-restored chats.
- Imported Composer chats no longer retain source `requestId` or `workspaceUris` bindings.
- Gist import tests mock `extensionContext.globalState` for post-import history and probe paths.
- Chat-import-merge golden fixtures align with timestamp stamping on header and composer-data rebind.

## v0.7.6

### Added
- **Export into Bundle (GIST)** on the Composer editor tab (`cursorSync.exportCurrentChatBundleToGist`) for single-conversation private Gist upload.
- **Batch chat bundle import** from local `chat-bundles.json` and Gist collections (multi-select picker, continue-on-failure summary via `restoreChatBundlesBatch`).
- **Composer conversation titles** from `composer.composerHeaders` / `allComposers[].name` in export and import pickers (`composer-title.ts`).
- **Sidebar writeback queue** after disk import: immediate `state.vscdb` merge plus deferred flush on extension activate (`chat-import-sidebar-writeback.ts`).
- **`fetchGistFileContent`** downloads full gist payloads when the GitHub API marks files truncated.

### Changed
- Import rebind clears session bindings (`requestId`, `workspaceUris`) on sidebar ItemTable and Layer 4 composer rows (TypeScript + bundled Python).
- Chat bundle and Gist import outcomes use batch summaries for multi-chat imports; README notes window reload is optional when the UI is stale.
- Python transport: destination workspace rebind on `cursorDiskKV`, pin imported composer in `allComposers`, ItemTable `composerData` workspace stamp, SQLite busy timeouts; optional debug logging when `CURSOR_SYNC_DEBUG_LOG` is set.

### Fixed
- Gist collection import restores all selected conversations without aborting on the first failure.
- `restoreChatBundle` tolerates extension contexts without `globalState` (integration tests).

## v0.7.5

### Added
- **Chat gist encryption**: optional client-side encryption for `chat-bundle.json` and `chat-bundles.json` Gist uploads (`cursorSync.chatGist.encrypt`, default on) using Argon2id + AES-256-GCM (`hash-wasm`).
- **`cursorSync.setChatEncryptionPassword`**: stores the chat encryption password in VS Code `SecretStorage` for export/import.
- Encrypted gist envelope (`cursorSyncEncrypted` v1) with per-export KDF salt and bound KDF parameters in the ciphertext metadata.

### Changed
- Chat gist export encrypts bundle JSON before `createGist` when encryption is enabled; import decrypts encrypted payloads before disk restore.
- Import verifies the encryption password (trial decrypt) before persisting it to `SecretStorage`.

### Fixed
- Decryption uses envelope-stored Argon2id parameters instead of hardcoded defaults.
- Single password prompt on import when the gist is encrypted (no duplicate prompts).
- Import does not save a wrong password when verification fails.

## v0.7.4

### Added
- **Chat tab export**: `Cursor Sync: Export into Bundle` on chat editor tab title and context menus (`cursorSync.exportCurrentChatBundle`) exports the clicked tab's conversation without the multi-chat picker.
- **Layer 4 in extension export**: `buildChatBundle` writes ChatBundle schema v2 with `diskKvSnapshot` from global `state.vscdb` when `cursorDiskKV` rows exist; warns when tool bubbles are missing on disk.
- **`chat-disk-kv-export.ts`**: per-key `cursorDiskKV` reads (avoids malformed-image errors on bulk SELECT under Cursor lock); `enrichBundleWithLiveDiskKv` fills missing snapshots via bundled Python on export/import.
- **`runPythonExportDiskKvSnapshot`**: Python fallback when TS sqlite reads fail on large or locked global `state.vscdb`.

### Changed
- Import restore enriches bundles with live Layer 4 before disk import; verify/activation use the enriched bundle.
- Bundled Python `export_disk_kv_snapshot` and tool-bubble counting use per-key reads with `busy_timeout` on live global DBs.
- SQLite helpers prefer Python for global `state.vscdb` at or above 256 MiB; import verify passes retry options for header reads.

### Fixed
- **Editor tab export**: resolves workspace when `~/.cursor/chats` has no store row but `agent-transcripts/<id>` exists on disk.

## v0.7.3

### Added
- **Debug with Cursor** on sync failure toasts (push, pull, Sync Now, scheduled sync): opens Composer with a sanitized debug prompt, or copies the prompt to the clipboard when Composer prefill is unavailable.
- `sync-debug.ts`: builds failure context for debugging (tokens, gist IDs, and paths redacted in prompts).

### Changed
- `executeSyncNow` exported; conflict/error/exception paths show a single debug toast without duplicating push/pull failure notifications.
- Scheduled sync surfaces debug toasts for conflict/error/exception; skips routine outcomes (`none`, in-progress, mocked `false` from push/pull).

### Fixed
- Sync failure debug toasts are fire-and-forget so push/pull locks and Sync Now / scheduled sync are not blocked while a notification is open.
- Cached extension version read and sanitized `category` in debug prompts.

## v0.7.2

### Added
- **ChatBundle schema v2** (`diskKvSnapshot`): Python `cursor_chat_io.py export` captures native `cursorDiskKV` rows (`composerData`, `bubbleId`) so tool/MCP Composer cards can round-trip across machines.
- **Transport fidelity UX**: import outcomes and the Chats sidebar show schema version, tool-bubble counts, and a warning when Layer 4 falls back to text-only synthesis (schema v1 or v2 without `diskKvSnapshot`).

### Changed
- Python disk import prefers native `diskKvSnapshot` remap over `build_cursor_disk_kv_rows_from_bundle` when rows are present.
- Bundled transport-chat reference documents Layer 4 export/import and inspect output.

### Fixed
- Gist chat import tests mock `showWarningMessage` for text-only Layer 4 fidelity warnings.
- **Security**: `diskKvSnapshot` import validates and filters `cursorDiskKV` keys to `composerData:{conversationId}` and `bubbleId:{conversationId}:*` (TS + Python). `transportChatScriptDir` honors user-global settings only (workspace overrides cannot redirect Python).

## v0.7.1

### Fixed
- **Chats tab Open / Re-activate**: `activateExistingChat` now syncs disk layers (Python transport), merges sidebar state into `state.vscdb`, and picks the right bundle mode (export bundle, header-only, minimal stub, or existing rich composer data) before IDE activation.
- **Composer activation**: prefers `composer.openComposer` / `composer.focusComposer` with handle polling; sidebar Open can skip staging `pending.json` and accept open-without-handle when `store.db` is already on disk.
- **store.db meta**: `decodeStoreDbIndex` parses hex-encoded JSON meta values; `storeMetaRecord` helper for activation decisions.
- **Sidebar webview**: client script moved to bundled `resources/sidebar/webview.js`; sync tab refreshes via `postMessage` instead of resetting full HTML (preserves Chats/Settings tab state).
- **Open fallback**: when native chat UI activation fails, opens the agent transcript `.jsonl` when available and surfaces actionable reload/re-import hints.

### Changed
- VSIX packaging ships `resources/sidebar/webview.js` instead of `golden-chat-store.template.db` (template remains in repo for tests only).

## v0.7.0

### Added
- Sidebar webview is now tab-based: **Sync** (existing), **Chats** (new), and **Settings** (surfaces `cursorSync.chatImport.*` knobs).
- **Chats tab** with three sections: Recent in this workspace (driven by `listConversationsForWorkspace`), Imports & bundles (backed by a new `cursorSync.chatImports` history in `globalState`, capped at 200), and live progress for in-flight imports.
- `src/chat-progress-events.ts`: `EventEmitter`-based channel (`onChatImportProgress`) that the sidebar subscribes to for Phase A / Phase B telemetry.
- `src/chat-activate-existing.ts`: `activateExistingChat` helper that re-runs Phase B (`composer.createComposer`) without re-writing disk; powers the "Re-activate" sidebar action.
- `cursorSync.chatImport.pythonPath` and `cursorSync.chatImport.transportChatScriptDir` settings.
- `ensurePythonReady()` pre-flight that probes `python3 --version` (or the configured interpreter) once per session.

### Changed
- **Python transport-chat scripts are now bundled in the VSIX** under `resources/transport-chat/scripts/`. Script resolver (`resolveTransportChatScript`, `resolveComposerBridgeScript`) prefers `<extensionPath>/resources/transport-chat/scripts/` and accepts `cursorSync.chatImport.transportChatScriptDir` as an override.
- Disk import now **requires** the bundled Python scripts; the legacy TypeScript fallback in `restoreChatBundle` (`!diskHandledByPython` branches) is removed. Missing Python or missing scripts now throw a clear, actionable error instead of silently degrading sidebar merge.
- Sidebar refactored from a single `src/sidebar.ts` into `src/sidebar/{index,html,messages,sync-tab,chats-tab,settings-tab,import-history,bundle-discovery}.ts`. Public API (`initializeSidebar`, `refreshSidebar`) is unchanged.

### Removed
- `cursorSync.installSkillTransportChat` command and the Linux-only skill-install path. The Python scripts no longer need to be copied to `~/.cursor/skills/transport-chat/`.
- `cursorSync.transcriptBrowser` tree view ("Imported Transcripts"). The three commands (`refreshImportedTranscripts`, `openImportedTranscript`, `revealImportedTranscriptInExplorer`) remain registered for one release as deprecation stubs that point users at the new Chats tab.
- `~/.cursor/skills/transport-chat/scripts/*` lookup paths from the script resolvers.

### Deprecated
- `src/chat-import-merge.ts:mergeTargetsForImport` and `mergeSidebarIntoStateDb` (JSDoc `@deprecated`). They are no longer called by `restoreChatBundle`; retained briefly for tests.

## v0.6.0

### Added
- Chat export QuickPick: select workspace and multiple conversations from disk instead of typing IDs; human-readable workspace and conversation labels.
- Batch chat export/import via `chat-bundles.json` / `ChatBundlesCollection` wrapper (gist and local save/load).
- `Cursor Sync: Install Skill - Transport Chat` command (Linux only): copies bundled `resources/transport-chat` into `~/.cursor/skills/transport-chat/`.
- Golden store template v2 (`PRAGMA user_version = 2`): `blobs(id, data)` and content-addressed hydration from manifest or `ChatBundle` transcripts.

### Changed
- import-v2 disk restore (`store.db`, `state.vscdb`) runs through bundled transport-chat Python scripts when the skill is installed; extension retains IDE activation (`composer.createComposer`, pending.json watcher).
- Composer activation: `composer.getComposerHandleById` fallback, pending-manifest fingerprint matching, and optional `skipPythonBridge` for extension-only activation.

## v0.5.0

- feat: import-v2 `ChatBundle` restore with modular merge, partial state, workspace context, and disk/activation verification.
- feat: `composer.createComposer` activation via pending.json watcher and Python bridge fallback (`docs/chat-import-activate.md`).
- feat: export/import single-conversation chat bundles to private Gists (`chat-bundle.json`) using the same pipeline as local save/load.
- fix: run SQLite scripts through a temp file and `sqlite3 .read` so hydration and store updates work reliably on Linux (stdin piping to `sqlite3` was timing out).

## v0.4.9

- feat: add default sync glob `vsix/**` under the Cursor `User` directory so packaged `.vsix` files are backed up with settings; each `.vsix` may be up to 50 MiB regardless of `cursorSync.maxFileSizeKB`.
- feat: add `Cursor Sync: Save Chat Locally` and `Cursor Sync: Load Chat from Local Bundle` using a bundled golden SQLite template and manifest-driven hydration.
- feat: add `Cursor Sync: Export Chat to Private Gist` and `Cursor Sync: Import Chat from Private Gist` for single-conversation `ChatBundle` sharing via private Gists (`chat-bundle.json`), reusing the same build/restore pipeline as local save/load.
- feat: add transcript import from a gist URL, state reconciliation commands for `chats.json`, and landing-zone preparation for sync.
- feat: add sync manifest/engine layer, chat ID alignment, and composer payload merge helpers to support the above flows.

## v0.4.6

- fix: replace fake `workspaceIdentifier` in gist import with `stampWorkspaceIdentifierOnPayload` so imported chats match the real open workspace and appear in the sidebar.
- chore: remove debug logging (`ultraDebugLog`) from gist import flow.

## v0.4.4

- fix: implement deterministic transcript bundle v2 restore mapping with preflight validation for artifact integrity and store workspace resolution.
- fix: restore store artifacts to canonical `~/.cursor/chats/<workspace>/<conversation>/store.db` targets and extend import reporting with per-artifact restore breakdown.
- fix: add best-effort sidebar state restoration by merging `composer.composerHeaders` into `state.vscdb` while preserving rollback-backed file writes.
- test: expand transcript fidelity coverage for v2 preflight failures, store mapping behavior, and full restore outcome messaging while preserving v1 compatibility.
- docs: align transcript fidelity and simulation verification docs with full-restore semantics and degraded-path warnings.
- docs: clarify GitHub token setup in `README.md` to specify using Personal access tokens > Fine-grained tokens with Account permission `Gists: Read and write` (see [GitHub issue #7](https://github.com/Marcelo-Barella/cursor-sync/issues/7) for details).

## v0.4.3

- fix: harden transcript export/import by introducing a checksum-validated bundle manifest that supports richer artifact mapping and safer restore behavior.
- fix: improve import safety with conflict preview/selection plus rollback-backed writes for existing transcript targets.
- test: add transcript export/import fidelity coverage for checksum-backed export, exact JSONL byte preservation, `schemaVersion: 1` backward compatibility, and tolerant import of v2-style manifests with ignored extra artifacts.
- docs: add a transcript simulation verification playbook and clarify in `README.md` that current transcript export/import preserves JSONL files only, not `store.db` payloads or sidebar metadata.

## v0.4.2

- feat: agent transcript export/import with mandatory project targeting on import. Export discovers `~/.cursor/projects/*/agent-transcripts/*.jsonl`, builds a private Gist with a manifest, and import maps each source project to a local project folder before writing. Anyone with the gist URL can open it.
- feat: commands `Cursor Sync: Export Agent Transcripts` and `Cursor Sync: Import Agent Transcripts` (see `cursorSync.transcripts.enabled`, default off; `cursorSync.transcripts.maxFileSizeKB`).
- change: settings export/import gists are private; gist URLs remain accessible to anyone who receives them. Command titles now say Private Gist instead of Public Gist.

## v0.4.1

- feat: broaden default skills sync path from `skills/**/SKILL.md` to `skills/**` so all files under the skills directory are synced, not just SKILL.md files.

## v0.4.0

- feat: replace the TreeView sidebar with a Webview-based panel featuring a rich HTML/CSS interface that adapts to any VS Code theme.
- feat: add an always-visible status card at the top of the sidebar showing sync state, last sync time (relative), sync direction, and tracked file count.
- feat: add a history panel listing up to 50 past sync operations with direction, trigger type, file count, success/failure indicator, and relative timestamps.
- feat: add `Cursor Sync: Sync Now` command that automatically determines whether to push, pull, or both based on local and remote changes.
- feat: Sync Now is available as a sidebar button, a view title toolbar icon, and a Command Palette entry.
- feat: action grid in sidebar provides quick access to Push, Pull, Export, and Import.

## v0.3.2

- feat: scheduled auto-sync now performs pull-push instead of push-only. The scheduler fetches the remote Gist manifest and compares file checksums against local state to determine whether to pull, push, both, or skip.
- feat: `executePull` accepts a `trigger` option; scheduled pulls bypass safe mode confirmation.
- feat: sync is skipped when no changes are detected on either side, and conflicts on the same file block the scheduled sync with a logged warning.

## v0.3.1

- feat: add `cursorSync.syncExtensions.autoInstall` (default `true`) to automatically install extensions from the synced list on pull.
- feat: add `cursorSync.syncExtensions.autoUninstall` (default `false`) and optional confirmation to uninstall extensions that are not in the synced list on pull.

## v0.3.0

- feat: change `cursorSync.schedule.enabled` default to `true`.
- feat: add `Cursor Sync: Export Settings to Public Gist` command to selectively share settings via public Gists.
- feat: add `Cursor Sync: Import Settings from Public Gist` command to import settings from a public Gist URL or ID without requiring a GitHub token.

## v0.2.1

- feat: add `Cursor Sync: Reset Extension State` command to easily clear the GitHub token, sync state, and reset configuration to defaults.

## v0.2.0

- feat: anonymous usage metrics are collected to help improve the extension. No sensitive data (tokens, gist IDs, file paths, or error messages) is ever sent.

## v0.1.6

- feat: add sidebar view and status bar item for Cursor Sync.
- feat: add icons to push and pull commands.
- fix: remove `skills-cursor/**/SKILL.md` from default sync paths.

## v0.1.5

- docs: added changelogs for previous versions.

## v0.1.4

- chore: update package version to 0.1.4 in package.json.
- Save sync state when an existing Gist is found.

## v0.1.3

- feat: enhance Gist management and update package metadata.
- Find existing Gists in GistClient; pull and push use existing Gist when not configured.
- Package version set to 0.1.3; icon path added; assets/icon.png included; .vscodeignore updated for packaging.

## v0.1.1

- chore: update package metadata and add prepublish script.
- Publisher name set to Marcelo Barella; repository URL added in package.json.
- Prepublish script runs build before publishing.
- .cursor added to .gitignore.

## v0.1.0

Initial release.

- Manual push and pull of Cursor user-level settings to a private GitHub Gist.
- Cross-platform support: Windows, macOS, Linux.
- Syncs settings.json, keybindings.json, snippets, rules, skills, and commands.
- Auto-generated extensions.json listing installed extensions.
- Conflict detection and resolution when both local and remote have changed.
- Optional scheduled auto-sync with configurable interval.
- Safe mode: confirmation prompt before pull overwrites.
- Automatic rollback on failed pull operations.
- Retry with exponential backoff for transient API errors.
- Output channel logging for all sync operations.
- PAT stored securely in VS Code SecretStorage.
