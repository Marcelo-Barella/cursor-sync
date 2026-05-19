# Cursor Sync

Sync user-level Cursor settings and `~/.cursor` assets to a private GitHub Gist, with manual push/pull, optional scheduled pull-push, export/import via private Gists (anyone with the gist URL can still open it), and configurable extension sync.

## What Is Synced

### Cursor User Config

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\Cursor\User\` |
| macOS    | `~/Library/Application Support/Cursor/User/` |
| Linux    | `~/.config/Cursor/User/` |

Files included from this root (configurable via `cursorSync.enabledPaths`):
- `settings.json`
- `keybindings.json`
- `snippets/**`
- `extensions.json` (auto-generated list of installed extensions on push)

### Cursor User Data (`~/.cursor`)

Files included from this root:
- `skills/**`
- `skills-cursor/**/SKILL.md`
- `commands/**/*.md`
- `rules/*.mdc`

### Always Excluded

The following are always excluded from sync:
- `.cursor/extensions/`, `.cursor/logs/`, `.cursor/CachedData/`, `.cursor/CachedExtensions/`
- `.cursor/CachedProfilesData/`, `.cursor/Crashpad/`, `.cursor/DawnCache/`, `.cursor/GPUCache/`
- `.cursor/blob_storage/`, `.cursor/Local Storage/`, `.cursor/Session Storage/`
- `.cursor/Network/`, `.cursor/shared_proto_db/`, `.cursor/databases/`
- `.cursor/TransportSecurity`, `.cursor/Cookies*`, `.cursor/*.db`, `.cursor/*.log`
- Any file exceeding the configurable size limit (default 512 KB)

## Setup

### 1. Create a GitHub Personal Access Token

1. Go to [GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/personal-access-tokens/new).
2. Create a fine-grained token and grant **Account permissions > Gists: Read and write**.
3. Copy the token.

### 2. Configure the Extension

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Cursor Sync: Configure GitHub**.
3. Paste your token when prompted.
4. The token is validated and stored in VS Code SecretStorage.

### 3. Push Your Settings

1. Run **Cursor Sync: Push Now** from the Command Palette or from the Cursor Sync sidebar (Actions → Push Now).
2. A private Gist is created (or updated) with all synced files.

### 4. Pull on Another Machine

1. Install the extension on the target machine.
2. Configure your GitHub token (step 2).
3. Push first from the source machine, then run **Cursor Sync: Pull Now** on the target.
4. If safe mode is enabled (default), you will be shown a list of files that will change and must confirm.

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Sync: Sync Now` | Automatically determine and execute the right sync action (push, pull, or both) |
| `Cursor Sync: Configure GitHub` | Set or update your GitHub Personal Access Token |
| `Cursor Sync: Push Now` | Upload local settings to the private Gist |
| `Cursor Sync: Pull Now` | Download settings from the Gist and apply locally |
| `Cursor Sync: Show Status` | Display last sync time, direction, file count, and Gist URL |
| `Cursor Sync: Resolve Conflicts` | Resolve files that changed both locally and remotely (shown when conflicts exist) |
| `Cursor Sync: Reset Extension State` | Clear token, sync state, and reset extension settings to defaults |
| `Cursor Sync: Export Settings to Private Gist` | Export selected files to a new **private** Gist; requires token; anyone with the URL can open the gist |
| `Cursor Sync: Import Settings from Private Gist` | Import settings from a Gist by URL or ID using the GitHub API (configure a token for private gists) |

## Sidebar

The **Cursor Sync** view in the activity bar provides a rich webview panel:

- **Status card** — Always visible at the top. Shows whether settings are synced, last sync time as a relative timestamp (e.g. "5m ago"), sync direction (push/pull), and the number of tracked files.
- **Sync Now** — A primary button that automatically determines the right action (push, pull, or both) and executes it. Also available as a toolbar icon in the view title bar.
- **Actions** — Quick-access grid with Push, Pull, Export, and Import buttons.
- **History** — Scrollable list of past sync operations (up to 50 entries) showing direction, trigger type (manual or auto), file count, success/failure status, and relative timestamps.
- **Configure GitHub** — Token setup link at the bottom.

Commands such as Resolve Conflicts and Reset are available from the Command Palette when applicable.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cursorSync.enabledPaths` | `string[]` | *(see path matrix above)* | Glob patterns for included sync paths |
| `cursorSync.excludeGlobs` | `string[]` | `[]` | Additional glob patterns to exclude |
| `cursorSync.schedule.enabled` | `boolean` | `true` | Enable periodic auto-sync (pull and push) |
| `cursorSync.schedule.intervalMin` | `number` | `30` | Minutes between scheduled syncs (minimum 5) |
| `cursorSync.maxFileSizeKB` | `number` | `512` | Skip files larger than this size in KB |
| `cursorSync.syncProfileName` | `string` | `"default"` | Logical profile label stored in `manifest.json` (see [Sync profiles](#sync-profiles)) |
| `cursorSync.safeMode` | `boolean` | `true` | Require confirmation before pull overwrites local files |
| `cursorSync.syncExtensions.autoInstall` | `boolean` | `true` | On pull, auto-install extensions that are in the synced list but not installed locally |
| `cursorSync.syncExtensions.autoUninstall` | `boolean` | `false` | On pull, auto-uninstall extensions that are installed locally but not in the synced list (use with caution) |

## Export and Import

- **Export**: Run **Cursor Sync: Export Settings to Private Gist**. You choose which synced files to include; a new **private** Gist is created and the URL can be copied to share (e.g. with others or for backup). Requires a configured GitHub token. Anyone with the link can open the gist.
- **Import**: Run **Cursor Sync: Import Settings from Private Gist** and enter a Gist URL or ID. You choose which files to apply locally. The extension uses your configured token to fetch the gist via the GitHub API (required for private gists).

## Agent Transcript Export and Import

- **Export**: Run **Cursor Sync: Export Agent Transcripts to Private Gist**. The extension exports selected `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` files and writes a `transcript-manifest.json` (`schemaVersion: 2`) with transcript/store/sidebar artifact metadata and checksums.
- **Import**: Run **Cursor Sync: Import Agent Transcripts from Private Gist**. Each source project is mapped to a local Cursor project, then selected conversation artifacts are restored with preflight validation before any writes.
- **Deterministic restore mapping**: Store artifacts restore to `~/.cursor/chats/<workspace-key>/<conversation-id>/store.db` using explicit `sourceWorkspaceKey` metadata and import-time workspace mapping when needed, not project-folder heuristics.
- **Sidebar/state behavior**: Sidebar metadata JSON sidecars are restored under `agent-transcripts/<conversation-id>/cursor-sidebar-metadata.json`, and import attempts to merge `composer.composerHeaders` plus optional `composer.composerData` into local `state.vscdb` when payload and DB are available.
- **Reload after state merge**: When state DB merge succeeds, the extension offers a `Reload Window` action because Cursor may not hot-reload SQLite-backed sidebar state.
- **Fallback usability**: Use the `Imported Transcripts` tree view in the Cursor Sync activity container to open restored JSONL files even when native composer rows are not immediately visible.
- **Fidelity guarantee**: Selected transcript JSONL files are preserved as exact UTF-8 bytes across export and import with checksum verification. Import remains backward compatible for `schemaVersion: 1` transcript-only manifests.
- **Degraded restore visibility**: Completion output reports restored counts for transcript/store/sidebar/state merge and warns when sidebar state merge is partial or skipped.
- **Verification**: Use [`docs/transcript-simulation-verification.md`](docs/transcript-simulation-verification.md) for checksum checks, path checks, and full-restore verification.

## Extension List Sync

On push, the extension generates an `extensions.json` file listing all installed non-builtin extensions with their IDs and versions. On pull:

- If **Auto-install** is enabled (default): extensions present in the synced list but not installed locally are installed automatically.
- If **Auto-install** is disabled: a notification lists missing extensions; they are not installed.
- Extensions installed locally but not in the synced list: if **Auto-uninstall** is enabled, they are uninstalled; if disabled, you are prompted to confirm removal.

Extensions are installed at the latest available version; the synced list records versions for reference only.

## Sync profiles

Cursor Sync does **not** yet switch or manage Cursor IDE user profiles (the in-app profile picker). It does support a **logical sync profile** via `cursorSync.syncProfileName`:

- On push/export, the name is written to `manifest.json` as `syncProfileName`.
- On pull, if the remote manifest profile differs from your local setting, you get an informational notice; the pull still proceeds.
- Use **different profile names** together with **separate Gists** (separate tokens or reset and push to a new Gist) when you want isolated backups—for example `work` vs `personal`.

Full multi-profile UX (create/switch profiles from the extension) is tracked in [GitHub issue #10](https://github.com/Marcelo-Barella/cursor-sync/issues/10).

## Security

- Your GitHub PAT is stored exclusively in VS Code SecretStorage. It never appears in settings files, logs, or telemetry.
- Sync uses a single **private** Gist per token (identified by description "Cursor Sync - Settings Backup"). Export creates an additional **private** Gist when you explicitly run Export; anyone with that URL can open it.
- No data is sent to any service other than the GitHub Gist API for sync and export operations.
- **Anonymous usage metrics**: The extension may send anonymous usage metrics (e.g. sync completed/failed, feature usage) to improve the extension. No sensitive data—tokens, gist IDs, file paths, or error messages—is included.

## Conflict Resolution

If a file has changed both locally and remotely since the last sync, push or pull is blocked. Run **Cursor Sync: Resolve Conflicts** to decide for each conflicted file: keep local, keep remote, or skip (decide later). The command is enabled only when there are pending conflicts.

## Recovery

If a pull (or import) fails partway through writing files, all partially written files are automatically rolled back to their pre-pull state using backup snapshots. The extension keeps the last 3 backup snapshots and prunes older ones. Restore from backup is not exposed in the UI; only automatic rollback on failure is performed.

## Reset

**Cursor Sync: Reset Extension State** clears your GitHub token, sync state (e.g. Gist ID, checksums), and resets the following settings to their defaults: `enabledPaths`, `excludeGlobs`, `schedule.enabled`, `schedule.intervalMin`, `maxFileSizeKB`, `syncProfileName`, `safeMode`. It does not change `syncExtensions.autoInstall` or `syncExtensions.autoUninstall`. Use this to start over or move to a new machine without reusing the previous Gist.
