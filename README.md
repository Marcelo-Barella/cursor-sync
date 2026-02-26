# Cursor Sync

Sync user-level Cursor settings and `~/.cursor` assets to a private GitHub Gist, with manual push/pull commands and optional scheduled sync.

## What Is Synced

### Cursor User Config

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\Cursor\User\` |
| macOS    | `~/Library/Application Support/Cursor/User/` |
| Linux    | `~/.config/Cursor/User/` |

Files included from this root:
- `settings.json`
- `keybindings.json`
- `snippets/**`
- `extensions.json` (auto-generated list of installed extensions)

### Cursor User Data (`~/.cursor`)

Files included from this root:
- `skills/**/SKILL.md`
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

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens).
2. Create a new token with the **gist** scope.
3. Copy the token.

### 2. Configure the Extension

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Cursor Sync: Configure GitHub**.
3. Paste your token when prompted.
4. The token is validated and stored in VS Code SecretStorage.

### 3. Push Your Settings

1. Run **Cursor Sync: Push Now** from the Command Palette.
2. A private Gist is created (or updated) with all synced files.

### 4. Pull on Another Machine

1. Install the extension on the target machine.
2. Configure your GitHub token (step 2).
3. Push first from the source machine, then run **Cursor Sync: Pull Now** on the target.
4. If safe mode is enabled (default), you will be shown a list of files that will change and must confirm.

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Sync: Configure GitHub` | Set or update your GitHub Personal Access Token |
| `Cursor Sync: Push Now` | Upload local settings to the private Gist |
| `Cursor Sync: Pull Now` | Download settings from the Gist and apply locally |
| `Cursor Sync: Show Status` | Display last sync time, direction, file count, and Gist URL |
| `Cursor Sync: Resolve Conflicts` | Resolve files that changed both locally and remotely |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cursorSync.enabledPaths` | `string[]` | *(see path matrix)* | Glob patterns for included sync paths |
| `cursorSync.excludeGlobs` | `string[]` | `[]` | Additional glob patterns to exclude |
| `cursorSync.schedule.enabled` | `boolean` | `false` | Enable periodic auto-sync |
| `cursorSync.schedule.intervalMin` | `number` | `30` | Minutes between scheduled syncs (minimum 5) |
| `cursorSync.maxFileSizeKB` | `number` | `512` | Skip files larger than this size in KB |
| `cursorSync.syncProfileName` | `string` | `"default"` | Profile name written to the sync manifest |
| `cursorSync.safeMode` | `boolean` | `true` | Require confirmation before pull overwrites |

## Security

- Your GitHub PAT is stored exclusively in VS Code SecretStorage. It never appears in settings files, logs, or telemetry.
- All Gists created by this extension are **private**.
- No data is sent to any service other than the GitHub Gist API.
- No telemetry is collected.

## Conflict Resolution

If a file has changed both locally and remotely since the last sync, the push or pull operation is blocked. Run **Cursor Sync: Resolve Conflicts** to decide for each conflicted file whether to keep the local version, the remote version, or skip (decide later).

## Recovery

If a pull operation fails partway through writing files, all partially written files are automatically rolled back to their pre-pull state using backup snapshots. The extension keeps the last 3 backup snapshots and prunes older ones.

## Extension List

On push, the extension generates an `extensions.json` file listing all installed non-builtin extensions with their IDs and versions. On pull, this file is written locally and a notification lists any extensions present remotely but not installed locally. Extensions are not auto-installed.
