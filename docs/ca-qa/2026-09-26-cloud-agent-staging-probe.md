# Cloud Agent QA probe: build, sideload, staging (2026-09-26)

Exploratory read-only probe of `cursor-sync` @ `main` (`480264f`, v0.8.0). No product/runtime changes. Staging host referenced by QA: `https://sync.bergamota.dev`.

## 1. Build and VSIX output

| Step | Command | Notes |
|------|---------|--------|
| Install | `npm ci` | Node 20; lockfile present |
| Compile | `npm run build` | `node esbuild.mjs` → `dist/extension.js` (CJS, bundles `src/extension.ts`, `external: ["vscode"]`, minify unless `--watch`) |
| Typecheck | `npm run lint` | `tsc --noEmit` |
| Unit tests | `npm test` | `vitest run` (374 tests passed on probe VM) |
| Package | `npm run package` | `vsce package --no-dependencies`; runs `vscode:prepublish` → `npm run build` first |

**VSIX path:** repo root `cursor-sync-<version>.vsix` (e.g. `cursor-sync-0.8.0.vsix`). Helper: `./package-vsix.sh` (`npm ci` if needed, then `npm run package`).

**Shipped artifacts (`.vscodeignore`):** `dist/extension.js`, icon, sidebar webview JS, bundled `resources/transport-chat/scripts/*.py`, golden store template under `resources/transport-chat/resources/`.

**Dependencies:** runtime `hash-wasm`, `minimatch`; dev `esbuild`, `typescript`, `vitest`, `@vscode/vsce`. Python 3 optional at runtime for legacy disk paths (`cursorSync.chatImport.pythonPath`).

**Marketplace publish (out of scope for CA QA):** `.github/workflows/publish-open-vsx.yml` publishes to Open VSX on `main` when `package.json` version changes (`ovsx publish` with `OVSX_PAT`). No VS Code Marketplace workflow in-repo. Do not run `vsce publish` / `ovsx publish` from CA QA.

## 2. Sideload recipe (local Sync Tester)

Documented implicitly in `docs/chat-import-activate.md` (extension install path under `~/.cursor/extensions/marcelobarella.cursor-sync-*`).

**Recommended flow:**

```bash
cd /path/to/cursor-sync
npm ci
npm run package
# artifact: ./cursor-sync-$(node -p "require('./package.json').version").vsix
```

**Install (pick one):**

- Cursor / VS Code UI: Command Palette → **Extensions: Install from VSIX…** → select the `.vsix`.
- CLI (when `cursor` or `code` is on PATH):  
  `cursor --install-extension ./cursor-sync-0.8.0.vsix --force`  
  (or `code --install-extension …` on VS Code).

**Extension id:** `MarceloBarella.cursor-sync` (`publisher` + `name` in `package.json`).

**Typical install locations:**

| OS | Cursor extensions dir |
|----|------------------------|
| Linux | `~/.cursor/extensions/marcelobarella.cursor-sync-<version>/` |
| macOS | `~/.cursor/extensions/...` |
| Windows | `%USERPROFILE%\.cursor\extensions\...` |

After sideload, **Reload Window** so the extension host loads the new build. `*.vsix` is gitignored; keep artifacts local or in CI artifacts.

**Dev loop:** `npm run watch` rebuilds `dist/extension.js`; for extension-host testing you still need reload or reinstall depending on how Cursor caches the folder.

## 3. Staging / backend URL configuration (today)

### Extension (this repo)

**There is no setting, env var, or constant for `sync.bergamota.dev` or any sync service base URL in product source** (verified: zero matches for `bergamota.dev` / `sync.bergamota` under `/workspace`).

**Remote sync today is GitHub Gist only:**

- API base: hardcoded `https://api.github.com` in `src/gist.ts` (`GITHUB_API`).
- Auth: GitHub PAT in SecretStorage (`cursorSync.githubPAT`), configured via **Cursor Sync: Configure GitHub** (`src/auth.ts`).
- README states data goes to GitHub Gist API only (aside from optional GA4 analytics).

**Related but not “staging host”:**

- `src/landing-zone-fetcher.ts` defines `LandingZoneFetcher` (Gist / HTTP / local **planned**); only the interface exists—no HTTP fetcher implementation in-tree.
- `cursorSync.prepareSyncFromLandingZone` reads a **local folder** containing `sync-manifest.json` (`src/sync-engine.ts`); no URL fetch.

**Hardcoded network endpoints in product source (flag for open-source / ops):**

| Location | Host / endpoint | Risk note |
|----------|-----------------|-----------|
| `src/gist.ts` | `https://api.github.com` | Expected; not user-configurable |
| `src/analytics.ts` | `https://www.google-analytics.com/mp/collect` + embedded GA4 measurement id / api secret | Third-party telemetry; not staging-related |
| UI placeholders / diagnostics | `https://gist.github.com/...` | User-facing links only |

**Implied future staging integration (from live staging SPA, not from extension code):**

- Web app at `https://sync.bergamota.dev` describes: install extension → sign in on site (email/password) → extension aligns machines.
- Minified client calls same-origin `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` with `Authorization: Bearer <token>`.
- Handoff URI: `cursor://MarceloBarella.cursor-sync/auth?token=<token>` (built in staging frontend bundle).
- **Extension v0.8.0 does not register a URI handler** (`package.json` has no `url` / `vscode.env` protocol contribution; no `registerUriHandler` in `src/`).

**Pointing a future build at staging without hardcoding hosts (recommended pattern):**

- Add something like `cursorSync.service.baseUrl` (user/workspace setting) or read from env only in dev docs—not committed defaults to production/staging domains.
- Implement `LandingZoneFetcher` HTTP variant against that base URL, or a dedicated sync client module.
- Staging frontend already uses relative API paths (`""` base)—deploy API on same origin or configure CORS + explicit base in extension setting.

### Staging probe (2026-09-26)

- `GET /` → 200 (marketing + auth UI).
- `POST /auth/login`, `/auth/signup`, `/auth/me` → **404** `NOT_FOUND` (Vercel). Frontend bundle expects these routes; **API appears not deployed (or not routed) on staging** at probe time.

## 4. Auth requirements for staging QA

**Do not commit or paste real tokens/passwords.**

| Actor | Credential | Purpose |
|-------|------------|---------|
| **Current extension (Gist mode)** | GitHub fine-grained PAT with **Gists: Read and write** | Push/pull/settings/chat gist export/import (`README.md`, `src/auth.ts`) |
| **Chat gist encryption (optional)** | User-chosen password via **Set Chat Encryption Password** | When `cursorSync.chatGist.encrypt` is true (`src/chat-encryption-auth.ts`) |
| **Staging web (intended)** | Email + password account on `sync.bergamota.dev` | Sign-up / sign-in in browser |
| **Staging web → extension (intended)** | Bearer token returned by login/signup, passed via `cursor://…/auth?token=` | Session handoff (frontend only today) |

**Gaps for end-to-end staging test:**

1. Staging auth API routes returned 404 on probe.
2. Extension has no code path to consume service token or call bergamota sync API.
3. E2E still requires local Cursor + sideloaded VSIX + browser sign-in + URI handoff.

## 5. Cloud Agent vs local Sync Tester

| Capability | Cloud Agent (this repo VM) | Local Sync Tester |
|------------|----------------------------|-------------------|
| `npm ci` / build / lint / `npm test` | Yes | Yes |
| `npm run package` → VSIX | Yes (artifact on VM; not in git) | Yes |
| `cursor` / `code` CLI sideload | **No** `cursor`/`code` on probe VM | Yes |
| Run extension in real Cursor host | **No** | Yes |
| Composer APIs (`composer.createNew`, `openComposer`) | **No** | Yes |
| Read/write `~/.cursor` SQLite (`state.vscdb`, chats) | Limited / not IDE-realistic | Yes |
| GitHub PAT in SecretStorage + push/pull UI | **No** | Yes |
| Staging browser login + `cursor://` handoff | **No** (no desktop Cursor) | Yes |
| HTTP probe staging landing (curl) | Yes (egress unrestricted) | Yes |

**Complement:** CA validates compile/test/package and documents integration gaps; local QA owns sideload, IDE behavior, Gist or (future) bergamota auth, and chat import fidelity.

## 6. Marketplace and hardcode risk notes

- **Marketplace:** Open VSX auto-publish on version bump only; CA must not publish. Sideload avoids marketplace entirely.
- **Hardcode rule:** Current `main` satisfies “no `sync.bergamota.dev` in product source.” Risk is **future** PRs that default `baseUrl` to staging/production—prefer settings + documented dev overrides.
- **Telemetry:** `analytics.ts` embeds GA4 secret in source (existing pattern); unrelated to staging but relevant for enterprise QA.

## 7. Recommended next tiny experiment (future CA run)

1. On a branch that **adds** (not merges) `cursorSync.service.baseUrl` + minimal health check command (no default host), run CA **unit tests only** for URL parsing and redaction.
2. In parallel, local tester: sideload `cursor-sync-0.8.0.vsix`, confirm **Configure GitHub** + **Push Now** against a throwaway PAT (gist scope)—baseline before bergamota backend wiring.
3. Re-probe staging when `/auth/login` returns non-404; document response shape and whether `cursor://MarceloBarella.cursor-sync/auth` is registered in a dev build.

---

**Probe commands run:** `npm ci`, `npm run build`, `npm run lint`, `npm test`, `npm run package`; `curl -I https://sync.bergamota.dev/`; dummy `POST` to `/auth/*` (no valid credentials).
