# Vidmyo — Providers, Agent Connection & Dock

**Date:** 2026-05-30
**Branch:** `feat/providers-agents-dock`
**Status:** Approved (build-it-all-now)

## Goal

Extend the existing Vidmyo Electron app with:
1. **OpenRouter** provider in Settings (new — genuinely missing).
2. **Google API** provider verified/working (already present as `google`).
3. **Real Codex OAuth** + **connect locally-installed AI agents** (replace the fake `prompt()` flow).
4. Rebuild the desktop app (1.0.11 → 1.1.0), reinstall to `/Applications`, keep it pinned to the Dock.

## Non-goals

- No full in-app OAuth2 client (agents handle their own auth, e.g. `codex login`).
- No rewrite of existing provider rendering or studios.
- No changes to `main` — all work on the feature branch.

## Architecture

Three isolated units, each with a clear boundary:

### Unit A — OpenRouter provider (data only)
`src/lib/providers.js`: add one OpenAI-compatible aggregator entry (`id: 'openrouter'`,
`baseUrl: https://openrouter.ai/api/v1`, `authHeader: Authorization`, `authPrefix: 'Bearer '`).
Renders automatically in Settings → Providers; key stored at `vidmyo_key_openrouter`. No new UI.
Google (`google`) verified: `generativelanguage.googleapis.com/v1beta`, key in query.

### Unit B — Agent bridge (Electron main + preload)
New `electron/lib/agents.js`, registered in `electron/main.js` next to `registerLocalInference()`.
Backed by `child_process`; surfaced via preload as `window.agents` (mirrors `window.localAI`).

| Channel | Behaviour |
|---|---|
| `agents:detect` | `which`/`--version` scan of known CLIs → `[{id, installed, path, version}]` |
| `agents:login` | Spawn agent's own login in Terminal (e.g. `codex login`) — real OAuth |
| `agents:authStatus` | Inspect local auth artifact (e.g. `~/.codex/auth.json`) |
| `agents:launch` | Open agent CLI in Terminal at a chosen cwd |
| `agents:setupMediaSkills` | `npx skills add SamurAIGPT/Generative-Media-Skills`, seed muapi key |

Known agents: `claude`, `codex`, `gemini`, `opencode`, `cursor-agent`, `hermes`.

### Unit C — Settings UI rewiring (renderer)
`src/components/SettingsModal.js` oauth-card branch: when `window.agents?.isElectron`,
use the bridge (real detect/login/status/launch + "Set up media skills"); otherwise fall
back to today's link-out flow labelled "Desktop app only". A small client wrapper
`src/lib/agentsClient.js` mirrors `localInferenceClient.js` for availability + calls.

### Media path
Connected agents generate media by driving muapi-cli / Generative-Media-Skills (already
promoted in `McpCliStudio.js`), authenticated with the saved Vidmyo/muapi key.

## Build & Dock
1. Bump `package.json` 1.0.11 → 1.1.0.
2. `npm run electron:build` (mac) → `release/mac-arm64/Vidmyo.app` + `.dmg`.
3. Quit running app; replace `/Applications/Vidmyo.app`.
4. Dock pin already added (`defaults` persistent-apps); path unchanged so it persists.

## Error handling
- All agent features no-op with a clear message when `window.agents` is absent (browser/hosted).
- `agents:detect` returns `installed:false` instead of throwing; UI shows Install.
- Login/skill failures surface via `react-hot-toast`.

## Testing
- Unit: `agents.js` detection/version parsing against mocked `execFile`.
- Manual: launch rebuilt app → Settings → Integrations → confirm real detection of installed
  CLIs, run `codex login`, confirm Dock pin and OpenRouter key entry.
