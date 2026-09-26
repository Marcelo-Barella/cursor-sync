# Cloud Agent VM: Cursor IDE install probe (2026-09-26)

Exploratory QA probe on Cloud Agent run `bc-edc6ca4d-a6d5-528c-90ac-489b1ff501b4` (Ubuntu environment, `cursor-sync` repo). No product code changes.

## 1. OS, architecture, display

| Item | Value |
|------|--------|
| OS | Ubuntu 24.04.4 LTS (Noble), kernel `6.12.94+` |
| Arch | `x86_64`, 4 CPUs |
| RAM | ~16 GiB total, ~7 GiB available at probe time |
| Disk | ~254 GiB on `/`, ~247 GiB free |
| `DISPLAY` | `:1` (set in agent shell) |
| GUI stack | TigerVNC on `:1` (1920x1200, depth 24), XFCE session, noVNC websockify on port 26058 |
| Extra | `xvfb` / `xvfb-run` installed; `xdpyinfo` works on `:1` |

Computer-use / screen recording is enabled on this pod (`--computer-use-enabled`, `--record-screen-enabled` on exec-daemon).

## 2. Pre-existing Cursor-related tooling (before manual install)

| Path / command | Role |
|----------------|------|
| `/exec-daemon/` | Cloud Agent runtime (Node), not desktop Cursor |
| `/opt/cursor/` | CA infrastructure (ansible, cloud-agent-tools, logs) — **not** the desktop IDE |
| `~/.cursor/` | Agent hooks, skills, plugins, `argv.json` — **no** `state.vscdb` |
| `cursor` / `code` in `PATH` | **Not present** until deb install |
| `cursor-agent` in `PATH` | **Not present** until first `cursor agent` invocation (installs to `~/.local/bin/cursor-agent`) |
| `/usr/local/bin/cursor-agent-store-fuse` | Persistent agent store FUSE mount |

## 3. Install sources and results

### Download URLs

- **Works:** `https://cursor.com/api/download?platform=linux-x64&releaseTrack=stable` returns JSON with `debUrl`, `downloadUrl` (AppImage), `rehUrl`, version `3.22.7`.
- **Fails:** `https://downloader.cursor.sh/linux/appImage/x64` — `curl: (6) Could not resolve host: downloader.cursor.sh`
- **Fails (stale redirect):** `https://api2.cursor.sh/updates/download/latest?platform=linux-x64&channel=stable` → Azure blob **404** (`The specified blob does not exist.`)

### `.deb` install (experiment)

```bash
wget -O /tmp/ca-qa-cursor/cursor.deb "<debUrl from API>"
sudo dpkg -i /tmp/ca-qa-cursor/cursor.deb
```

- Package: `cursor` 3.22.7-1790228161, ~199 MiB deb, ~964 MiB installed size.
- **Result:** success; `/usr/bin/cursor` available.
- `cursor --version` → `3.22.7` / commit `37076c6c3f9e253c0fa2305197e45befd13a2260`.

### `cursor agent` CLI

First `cursor agent --help` printed `cursor-agent not found, installing via https://cursor.com/install ...` and installed:

- `~/.local/bin/cursor-agent` → `~/.local/share/cursor-agent/versions/2026.09.26-dd393fe/cursor-agent`
- Version: `2026.09.26-dd393fe` (requires `PATH` including `~/.local/bin`).

This is the **terminal agent**, not a substitute for full Composer UI / extension-host integration tests.

## 4. Headless vs GUI launch

### With GUI (`DISPLAY=:1`, VNC)

```bash
cursor --user-data-dir /tmp/ca-qa-cursor/user-data \
  --extensions-dir /tmp/ca-qa-cursor/extensions \
  /workspace --disable-gpu --no-sandbox
```

- **Result:** Electron processes start; `xdotool` / `xwininfo` show windows titled `workspace - Cursor`.
- Telemetry in logs: `onboarding.started` with `is_authenticated: false`, landing screen `signedIn: false`.
- Sentry: `[unauthenticated] No authorization header found` on cpp config load (handled error).

### Ephemeral X (`xvfb-run`)

Same command with `xvfb-run -a` and isolated `--user-data-dir`:

- **Result:** Cursor starts (gpu/renderer processes observed). Minor `xkbcomp` warnings (non-fatal).

### Without `DISPLAY`

Unset `DISPLAY` and launch (CLI still returned exit 0 quickly; separate experiment):

- Cursor may still spawn if a display is implied elsewhere; **reliable automation should set `DISPLAY=:1` or use `xvfb-run`.**

### Flags

- `--no-sandbox` used in probe; launch **also succeeded without** `--no-sandbox` in a short test.
- No built-in “pure headless extension test runner” in `cursor --help` (unlike a dedicated test CLI). Standard pattern is GUI/Electron + extension host.

## 5. Sideload extension + repo tests

### VSIX

```bash
cd /workspace && npm install && npm run package
# → cursor-sync-0.8.0.vsix

cursor --install-extension /workspace/cursor-sync-0.8.0.vsix \
  --extensions-dir /tmp/ca-qa-cursor/extensions --force
```

- **Result:** `Extension 'cursor-sync-0.8.0.vsix' was successfully installed.`
- `cursor --list-extensions ...` → `marcelobarella.cursor-sync`
- On disk: `/tmp/ca-qa-cursor/extensions/marcelobarella.cursor-sync-0.8.0/`

### Unit tests (no IDE)

```bash
npm test   # vitest run
```

- **Result:** 50 files, 374 tests passed (~10s).

The repo has **no** `@vscode/test-electron` / integration test harness in `package.json`.

## 6. Resource and lifecycle notes

- Multiple Cursor instances can push aggregate RSS toward **~2–3 GiB**.
- Short `timeout` kills leave `extensionHost` / renderer exits with **code 15** (`killed`) in logs — expected when forcibly stopping GUI.
- No `state.vscdb` found under `/home/ubuntu` on this VM → **no native Composer/SQLite state** for chat-import fidelity tests without seeding fixtures or copying real `~/.cursor` / global storage from a dev machine.

## 7. Blockers for “install Cursor → sideload → run extension E2E” on CA

| Area | Severity | Notes |
|------|----------|--------|
| Cursor account login | High for AI/Composer | Fresh user-data shows onboarding, not signed in; PAT/Gist flows need SecretStorage + user setup |
| Composer / `state.vscdb` | High for chat-import QA | Absent on VM; extension’s hardest paths need real or fixture DBs |
| Auth secrets (GitHub PAT, chat encryption) | High for sync/gist | Must inject via CA secrets / manual setup; not in image |
| Install size / time | Medium | ~200 MiB download + ~1 GiB install; `sudo` for `dpkg` |
| Memory | Medium | Full IDE + extension host competes with agent (~16 GiB pod) |
| DNS | Low | `downloader.cursor.sh` does not resolve here; use `cursor.com/api/download` |
| Marketplace / license | Low | Sideload via VSIX works without Marketplace publish |
| Automated UI | Medium | VNC + computer-use can drive UI; no official headless E2E runner in repo |

## 8. Recommendation

| Workflow | Verdict |
|----------|---------|
| **CA + `npm test` (vitest)** | **Go** — already fits the image. |
| **CA + install Cursor deb + VSIX sideload + manual/VNC smoke** | **Conditional go** — technically works on this VM; use isolated `--user-data-dir` / `--extensions-dir`. |
| **CA + full Cursor Sync chat/composer/sync E2E without fixtures** | **No-go** without auth, `state.vscdb` seeding, and a documented login/secret bootstrap. |
| **CA + headless-only Cursor (no Electron)** | **No-go** for extension UI/integration; `cursor agent` CLI is a different product surface. |

**Overall:** Installing and running **Cursor desktop on this Cloud Agent VM is feasible** (deb from `cursor.com/api/download`, GUI via `:1` or `xvfb-run`, VSIX install via CLI). **Automated extension QA for Cursor-specific sync/chat features remains blocked** by authentication, lack of on-disk Composer state, and absence of an integration-test runner in the repo — unless the environment is extended (preinstall Cursor in `environment.json`, seed DB fixtures, store PATs, optional login flow).
