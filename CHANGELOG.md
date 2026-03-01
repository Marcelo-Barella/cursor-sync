# Changelog

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
