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

> Transport-chat Python scripts are bundled inside the extension (`resources/transport-chat/scripts/`) starting in v0.7.0. The previous `Cursor Sync: Install Skill - Transport Chat` command was removed; no separate install step is required.

## Sidebar

The **Cursor Sync** view in the activity bar is a tabbed webview:

### Sync tab
- **Status card** — Shows whether settings are synced, last sync time as a relative timestamp (e.g. "5m ago"), sync direction (push/pull), and the number of tracked files.
- **Sync Now** — A primary button that automatically determines the right action (push, pull, or both).
- **Actions** — Quick-access grid with Push, Pull, Export, and Import.
- **History** — Past sync operations (up to 50 entries) with direction, trigger, file count, status, and relative timestamps.
- **Configure GitHub** — Token setup link.

### Chats tab
- **Recent in this workspace** — Local conversations from `~/.cursor/chats/<md5(workspace)>/<uuid>/store.db`, with one-click Export Bundle / Export to Gist / Reveal Transcripts per row.
- **Imports & bundles** — `cursorSync.chatImports` history (max 200 entries) plus ad-hoc bundle files discovered under `/tmp/chat-transport-*.json` and `<globalStorage>/chat-bundles/*.json`. Each import row offers **Re-activate** (re-runs Phase B without re-writing disk) and **Reveal Transcripts**.
- **Active operation** — Live Phase A / Phase B status while an import runs, driven by the `onChatImportProgress` event emitter.

### Settings tab
Surfaces the most-used `cursorSync.chatImport.*` knobs (activate by default, strict activation, bridge wait result seconds, Python interpreter, auto-reload after import) as editable controls that call `vscode.workspace.getConfiguration().update(...)`.

Commands such as Resolve Conflicts and Reset are available from the Command Palette when applicable. The standalone "Imported Transcripts" tree view (`cursorSync.transcriptBrowser`) was removed in v0.7.0; the three commands remain as one-release deprecation stubs.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cursorSync.enabledPaths` | `string[]` | *(see path matrix above)* | Glob patterns for included sync paths |
| `cursorSync.excludeGlobs` | `string[]` | `[]` | Additional glob patterns to exclude |
| `cursorSync.schedule.enabled` | `boolean` | `true` | Enable periodic auto-sync (pull and push) |
| `cursorSync.schedule.intervalMin` | `number` | `30` | Minutes between scheduled syncs (minimum 5) |
| `cursorSync.maxFileSizeKB` | `number` | `512` | Skip files larger than this size in KB |
| `cursorSync.syncProfileName` | `string` | `"default"` | Profile name written to the sync manifest |
| `cursorSync.safeMode` | `boolean` | `true` | Require confirmation before pull overwrites local files |
| `cursorSync.syncExtensions.autoInstall` | `boolean` | `true` | On pull, auto-install extensions that are in the synced list but not installed locally |
| `cursorSync.syncExtensions.autoUninstall` | `boolean` | `false` | On pull, auto-uninstall extensions that are installed locally but not in the synced list (use with caution) |

## Export and Import

- **Export**: Run **Cursor Sync: Export Settings to Private Gist**. You choose which synced files to include; a new **private** Gist is created and the URL can be copied to share (e.g. with others or for backup). Requires a configured GitHub token. Anyone with the link can open the gist.
- **Import**: Run **Cursor Sync: Import Settings from Private Gist** and enter a Gist URL or ID. You choose which files to apply locally. The extension uses your configured token to fetch the gist via the GitHub API (required for private gists).

## Chat Export and Import

Single-conversation chat bundles (`type: chat-persistence`, `schemaVersion: 1`) capture transcript JSONL files, an optional `store.db` snapshot, and sidebar metadata for restore into the current workspace.

### Local bundle

- **Save**: Run **Cursor Sync: Save Chat Locally**. Enter a conversation ID (folder name under `agent-transcripts` or `~/.cursor/chats`). The extension builds a `ChatBundle` JSON file under extension global storage (`chat-bundles/`).
- **Load**: Run **Cursor Sync: Load Chat from Local Bundle** and pick a saved bundle file. Transcripts, store, and sidebar state are restored; project mapping is prompted when transcript paths span multiple source projects.

### Private Gist

- **Export**: Run **Cursor Sync: Export Chat to Private Gist** (`cursorSync.exportChatToGist`). Enter a conversation ID; requires a configured GitHub token. Creates a **private** Gist with `chat-bundle.json` only (description: `Cursor Sync - Chat Export`). Copy the URL to share; anyone with the link can open the gist.
- **Import**: Run **Cursor Sync: Import Chat from Private Gist** (`cursorSync.importChatFromGist`). Enter a Gist URL or ID; uses your token for private gists. Fetches and validates `chat-bundle.json`, then restores the conversation. Gists that contain only a transcript manifest are rejected—use **Import Agent Transcripts from Private Gist** for those. Restores without requiring a window reload; imported chats should appear in the sidebar after import (reload only if Cursor UI is stale).

## Agent Transcript Export and Import

- **Export**: Run **Cursor Sync: Export Agent Transcripts to Private Gist**. The extension exports selected `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` files and writes a `transcript-manifest.json` (`schemaVersion: 2`) with transcript/store/sidebar artifact metadata and checksums.
- **Import**: Run **Cursor Sync: Import Agent Transcripts from Private Gist**. Each source project is mapped to a local Cursor project, then selected conversation artifacts are restored with preflight validation before any writes.
- **Deterministic restore mapping**: Store artifacts restore to `~/.cursor/chats/<workspace-key>/<conversation-id>/store.db` using explicit `sourceWorkspaceKey` metadata and import-time workspace mapping when needed, not project-folder heuristics.
- **Sidebar/state behavior**: Sidebar metadata JSON sidecars are restored under `agent-transcripts/<conversation-id>/cursor-sidebar-metadata.json`, and import attempts to merge `composer.composerHeaders` plus optional `composer.composerData` into local `state.vscdb` when payload and DB are available.
- **Reload after state merge**: When state DB merge succeeds, the extension offers a `Reload Window` action because Cursor may not hot-reload SQLite-backed sidebar state.
- **Fallback usability**: Use the Chats tab in the Cursor Sync sidebar (Imports & bundles → Reveal Transcripts) to open restored JSONL files even when native composer rows are not immediately visible.
- **Fidelity guarantee**: Selected transcript JSONL files are preserved as exact UTF-8 bytes across export and import with checksum verification. Import remains backward compatible for `schemaVersion: 1` transcript-only manifests.
- **Degraded restore visibility**: Completion output reports restored counts for transcript/store/sidebar/state merge and warns when sidebar state merge is partial or skipped.
- **Verification**: Use [`docs/transcript-simulation-verification.md`](docs/transcript-simulation-verification.md) for checksum checks, path checks, and full-restore verification.

## Chat bundle import (import-v2)

Works with the **transport-chat** skill (`~/.cursor/skills/transport-chat`):

- **Disk** (transcripts, `store.db`, `state.vscdb`) — Python `cursor_chat_io.py` via `src/chat-transport-scripts.ts`; the extension does not merge `state.vscdb` when the skill is installed.
- **IDE** (`composer.createComposer`, `pending.json`, `result.json`) — this extension only.

- **Commands**: **Import Chat Bundle**, **Import Chat Bundle (Activate)**, **Export Chat Bundle**, **Verify Chat Import** (Command Palette).
- **Settings**: `cursorSync.chatImport.*` — mirror transport-chat `import` flags for activation timing.
- **CLI agents**: use `/transport-chat` or `transport_chat.py run`; Phase B completes via the extension watcher. Details: [`docs/chat-import-activate.md`](docs/chat-import-activate.md).

## Extension List Sync

On push, the extension generates an `extensions.json` file listing all installed non-builtin extensions with their IDs and versions. On pull:

- If **Auto-install** is enabled (default): extensions present in the synced list but not installed locally are installed automatically.
- If **Auto-install** is disabled: a notification lists missing extensions; they are not installed.
- Extensions installed locally but not in the synced list: if **Auto-uninstall** is enabled, they are uninstalled; if disabled, you are prompted to confirm removal.

Extensions are installed at the latest available version; the synced list records versions for reference only.

## Cursor Sync app (staging / custom API)

Developer settings under **Cursor Sync: Developer environment** (`cursorSync.developer.environment`):

| Preset | API | Website |
|--------|-----|---------|
| **staging** (default on the staging extension branch) | `https://api-staging.cursor-sync.com` | `https://staging.cursor-sync.com` |
| **production** | `https://api.sync.bergamota.dev` | `https://sync.bergamota.dev` |
| **local** | `http://localhost:8100` | `http://localhost:3000` |
| **custom** | `cursorSync.developer.apiUrl` | `cursorSync.developer.websiteUrl` |

Use **custom** with the legacy staging hosts (`https://api-staging-sync.bergamota.dev`, `https://staging.sync.bergamota.dev`) if needed. App login opens only trusted website origins (presets above plus your custom website URL when environment is **custom**).

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
