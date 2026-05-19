# Changelog

## Unreleased

- docs: document logical sync profiles (`cursorSync.syncProfileName`) and limitations vs Cursor IDE user profiles ([#10](https://github.com/Marcelo-Barella/cursor-sync/issues/10)).
- feat: show an informational notice on pull when the remote manifest profile name differs from the local setting.

## v0.4.9

- feat: add default sync glob `vsix/**` under the Cursor `User` directory so packaged `.vsix` files are backed up with settings; each `.vsix` may be up to 50 MiB regardless of `cursorSync.maxFileSizeKB`.
- feat: add `Cursor Sync: Save Chat Locally` and `Cursor Sync: Load Chat from Local Bundle` using a bundled golden SQLite template and manifest-driven hydration.
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
