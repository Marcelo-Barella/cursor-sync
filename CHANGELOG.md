# Changelog

## [Unreleased]

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
