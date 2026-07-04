# Vidmyo — Session Handoff (2026-07-03, Claude Fable 5)

Read this first, then: `docs/product/2026-07-03-vidmyo-product-architecture-package.md`
(the full plan; §14 = approved decisions + what's already executed) and
`/Volumes/My Lexar/Obsidian/Omi/Omi/agent-shared/vidmyo.md` (cross-agent log).

## Where things stand

Branch `feat/providers-agents-dock`, all work committed, `npm run vite:build` green:

| Commit | What |
|---|---|
| `5610fa0` | Baseline snapshot of previously-uncommitted feature work |
| `c48b313` | **Removed local image gen** (sd.cpp, Bonsai, ComfyUI). Wan2GP kept |
| `89a675e` | Security: `webSecurity:true` + `net:fetch` main-process proxy; keys → OS keychain (safeStorage) with localStorage migration; agents key-leak fix |
| `36d4f28` | Fresh-clone bootstrap without submodules; README truth pass (open-core wording) |
| `368a037` | Product-package addendum: approved tiers, Paddle decision, executed slice |

Milestone 1 is **done except**: single provider catalog (deliberately deferred into
`packages/core`, M2) and one live verification (below).

## Approved decisions (do not re-litigate)

- **Pricing:** Free (open-source core) / Creator $19/mo / Pro $49/mo / founding $12/mo ×200. Tier contents: package §14.3.
- **Payments:** Paddle at launch (Luke has an account). Revisit ≈$5k MRR (Polar/Creem/Dodo).
- **Image quality bar:** Google Flow (model choice incl. Nano Banana 2 Pro) + professional APIs + agents. **Never re-add sd.cpp/Bonsai/ComfyUI.** Flow provider ships in the Creator tier.
- **Wedge:** Story Studio faceless doodle MVP (pipeline exists as the external `faceless-doodle-video` skill; port it, don't reinvent).
- **Vite/Electron = canonical desktop surface;** Next.js surface frozen (Luke hasn't objected).
- **Higgsfield:** integrate via its official hosted MCP (`https://mcp.higgsfield.ai/mcp`, OAuth) — no browser automation, ever.
- **ElevenLabs:** Luke already has the affiliate link — ask him for it when building the voiceover card (M8). Affiliate must be disclosed and never functionally required.
- Standing rules: never use `gflow-cli`/`cua-driver`; scene selection by explicit `sNNN` ID only; one Flow scene at a time; verify downloads on disk + visually.

## Architecture invariants introduced this session (keep them)

- Renderer cloud requests go `src/lib/apiFetch.js` → `window.localNet.fetch` → `electron/lib/netProxy.js` (main-process fetch; https-only + private-host http). Do **not** add plain `fetch()` to cloud APIs in the desktop path — it will hit CORS now that webSecurity is on.
- Provider keys come from the OS keychain via `initSecureKeys()` (in-memory cache keeps `getSavedProviderKey` synchronous). Do not reintroduce localStorage key reads.
- `electron/lib/secrets.js` IPC: `secrets:available|get-all|set`. Preload surfaces: `localAI` (Wan2GP only), `secureKeys`, `localNet`, `agents`.

## M2 foundation shipped (commit `f9da846`, 2026-07-03 session 3)

`packages/core` (@vidmyo/core, pure Node ESM, 23 node:test cases green, root `npm test` runs them):

- `src/providers.js` — **canonical provider catalog** (drift resolved; muapi restored beside openrouter/fal; openrouter stays PROVIDERS[0]/default). Auth helpers are pure — key always an explicit argument.
- `src/jobs.js` — `JobStore`: one JSON file per job, atomic writes, enforced state machine queued→running→done|error|cancelled, logs/artifacts/checkpoints. Default dir `~/.vidmyo/jobs`.
- `src/project.js` — `Project` manifests (`project.json`, version 1): scenes resolve ONLY via `getScene('sNNN')` (throws on malformed/unknown), `acceptSceneArtifact()` requires the file on disk, `pendingScenes()` is the resume queue.
- `src/lib/providers.js` is now re-export from core + the browser/keychain key layer ONLY. `packages/studio/src/providers.js` carries a DEPRECATED header (frozen surface).
- New invariant: **provider entries are added only in `packages/core/src/providers.js`.**

## Immediate next steps (in order)

1. **Verify live:** launch the app (`npm run electron:dev`), save a real key (confirm it lands in `userData/secure-keys.json` encrypted, not localStorage), generate one image via fal/OpenRouter — proves the webSecurity+proxy path. Note: the Settings "Unified" section now also shows a Muapi card (restored canonical entry) — expected.
2. **M2 remainder — DONE (commit `704efe2`):** `src/run.js` (runJob: poll/cancel/resume/timeout) + `src/adapters/fal.js`; 28/28 tests. Live acceptance is one command away: `FAL_KEY=... node scripts/live-image-test.mjs` (performs ONE paid fal generation).
3. **M3 — Story Studio MVP** — STARTED (commits `aefb347`, + finalize vendoring):
   - Feasibility: VERIFIED straight port — `docs/product/2026-07-03-story-studio-port-feasibility.md`.
   - Vendored: full deterministic pipeline in `packages/core/pipelines/doodle/` (tts_kokoro, detect_beats, assemble, fix_captions, setup_env, finalize_video/master_audio/upscale_4k + style-spec + master-prompt). Read its README before touching assemble.py — the hold-to-next-cue logic must not be "simplified".
   - Core `src/story.js` (pure, 35/35 suite): DOODLE_STYLE, buildImagePrompt, validateScript (1,400-word gate), importBeats (sNNN drift assertion), scaffoldPrompts, stageStatus.
   - Runner DONE + **REAL-RUN VERIFIED** (commit `67b9f9f`): `src/pipeline.js` (DoodlePipeline, injectable exec, readiness for doctor) + `src/storyRunner.js` (stageVoiceover/Beats/Assemble/Finalize with gates). Smoke on this machine via the `Faceless YT 1/pipeline/.venv`: Kokoro → whisper (4 beats cut on real pauses) → ffmpeg; output.mp4 11.37s vs VO 11.40s (one-frame sync). Suite 48/48.
   - **Remaining for M3:** (a) doctor wrap of setup_env.sh so end users get their own venv (models are multi-hundred-MB — consent + progress; dev machines can point DoodlePipeline.venvPython at the Faceless YT 1 pipeline venv); (b) image-stage queue over Project.pendingScenes() with source picker (default Google Flow NB2 free — agent/manual until the Flow provider ships; NB2 *Pro* = explicit paid choice; Higgsfield MCP generate_image bills credits — behind explicit choice only); (c) Story tab UI — NOTE: core is Node-only, so the renderer needs a narrow story IPC surface in electron/main (core runs in the main process), same pattern as secrets/netProxy; (d) publish stage as a generic n8n-webhook route (Luke's Drive/tracker/Curio infra is deliberately NOT vendored).
4. Then M4 CLI/MCP exposure (import @vidmyo/core from `mcp/server.js`), M5 agent session briefs, Flow browser provider (raised priority, Creator tier).

## Known debts / cautions

- Graphify graph is stale: `graphify update .` refuses (679 vs 715 nodes; baseline predates the deletions); the CLI has no force flag — needs a forced rebuild via the Python API (`force=True`). Don't guess CLI flags (logged mistake 2026-06-04).
- Next.js surface (`app/` + `packages/studio`) still ships its own deprecated catalog copy — harmless while frozen.
- `mcp/smoke.mjs` needs Video Delta running (`python -m videodelta.api`, port 7861).
- README download links point at v1.0.9 assets named `Open.Generative.AI-*` — correct until a new release is cut.
- `.env` exists at repo root: never read or print its values.
- Workspaces now include `packages/core`; `npm install` hasn't been rerun (not needed — the renderer imports core by relative path).
