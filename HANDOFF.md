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
- **SURFACE DECISION REVERSED (2026-07-04):** Luke's daily app is the **Next.js dev shell** — `Start Vidmyo + Video Delta.command` runs `npm run dev` on :3210 and opens Electron at `/studio` with hot reload (`VIDMYO_DEV_URL`). Ship UI there first (`components/StandaloneShell.js` + `packages/studio`). The Vite renderer (`src/`) becomes the packaged desktop app later, when the software is stable. Electron main-process changes (electron/*.js) need an Electron restart — the dev URL only hot-reloads the renderer.
- **Higgsfield:** integrate via its official hosted MCP (`https://mcp.higgsfield.ai/mcp`, OAuth) — no browser automation, ever.
- **ElevenLabs:** Luke already has the affiliate link — ask him for it when building the voiceover card (M8). Affiliate must be disclosed and never functionally required.
- Standing rules: never use `gflow-cli`/`cua-driver`; scene selection by explicit `sNNN` ID only; one Flow scene at a time; verify downloads on disk + visually.

## Architecture invariants (keep them) — updated 2026-07-04 after the Vite-surface removal

- **ONE app**: the Next.js dev shell (`components/StandaloneShell.js` + `packages/studio`) served on :3210 and opened in Electron by the launcher. The Vite renderer was DELETED in `d343cfd` (git history keeps it for the future packaged app). Do not recreate `src/`.
- Provider keys: OS keychain via `window.secureKeys` (`electron/lib/secrets.js`); the Settings UI is `packages/studio/src/components/SettingsModal.jsx` over the canonical catalog. muapi key mirrors to legacy `vidmyo_cloud_key` for older shell consumers. Provider entries are added ONLY in `packages/core/src/providers.js`.
- Electron main runs with `webSecurity: true`. Direct renderer fetches must target CORS-permissive endpoints (Video Delta sends `access-control-allow-origin: *` — verified) or go through `window.localNet.fetch` → `electron/lib/netProxy.js`. Next server routes (`app/api/proxy`) are also fine.
- Preload surfaces: `localAI` (Wan2GP), `secureKeys`, `localNet`, `agents`, `story`, `media`. Electron main-process changes require restarting the Electron window; the page hot-reloads.
- Cloud Image/Video tabs (commit `979e53a`): `CloudImageStudio.jsx` / `CloudVideoStudio.jsx` over `electron/lib/mediaBridge.js` (fal via core runJob, keychain key, durable jobs in ~/.vidmyo). Curated endpoints: flux schnell/dev, veo3 + a custom-endpoint field because fal ids drift. The muapi-era ImageStudio/VideoStudio components stay exported but unrendered.

## M2 foundation shipped (commit `f9da846`, 2026-07-03 session 3)

`packages/core` (@vidmyo/core, pure Node ESM, 23 node:test cases green, root `npm test` runs them):

- `src/providers.js` — **canonical provider catalog** (drift resolved; muapi restored beside openrouter/fal; openrouter stays PROVIDERS[0]/default). Auth helpers are pure — key always an explicit argument.
- `src/jobs.js` — `JobStore`: one JSON file per job, atomic writes, enforced state machine queued→running→done|error|cancelled, logs/artifacts/checkpoints. Default dir `~/.vidmyo/jobs`.
- `src/project.js` — `Project` manifests (`project.json`, version 1): scenes resolve ONLY via `getScene('sNNN')` (throws on malformed/unknown), `acceptSceneArtifact()` requires the file on disk, `pendingScenes()` is the resume queue.
- `src/lib/providers.js` is now re-export from core + the browser/keychain key layer ONLY. `packages/studio/src/providers.js` carries a DEPRECATED header (frozen surface).
- New invariant: **provider entries are added only in `packages/core/src/providers.js`.**

## Immediate next steps (in order)

1. **Verify live (Luke, one sitting):** close the Vidmyo window, re-run the launcher (Electron restart picks up storyBridge/secrets/webSecurity). Then: Settings → add the fal key (check `userData/secure-keys.json` gets an encrypted entry) → Story tab → create project → paste script → run the stages. Session-5 commits: `d5b16ea` (real Settings modal), `d343cfd` (Vite surface removed).
2. **M2 remainder — DONE (commit `704efe2`):** `src/run.js` (runJob: poll/cancel/resume/timeout) + `src/adapters/fal.js`; 28/28 tests. Live acceptance is one command away: `FAL_KEY=... node scripts/live-image-test.mjs` (performs ONE paid fal generation).
3. **M3 — Story Studio MVP** — STARTED (commits `aefb347`, + finalize vendoring):
   - Feasibility: VERIFIED straight port — `docs/product/2026-07-03-story-studio-port-feasibility.md`.
   - Vendored: full deterministic pipeline in `packages/core/pipelines/doodle/` (tts_kokoro, detect_beats, assemble, fix_captions, setup_env, finalize_video/master_audio/upscale_4k + style-spec + master-prompt). Read its README before touching assemble.py — the hold-to-next-cue logic must not be "simplified".
   - Core `src/story.js` (pure, 35/35 suite): DOODLE_STYLE, buildImagePrompt, validateScript (1,400-word gate), importBeats (sNNN drift assertion), scaffoldPrompts, stageStatus.
   - Runner DONE + **REAL-RUN VERIFIED** (commit `67b9f9f`): `src/pipeline.js` (DoodlePipeline, injectable exec, readiness for doctor) + `src/storyRunner.js` (stageVoiceover/Beats/Assemble/Finalize with gates). Smoke on this machine via the `Faceless YT 1/pipeline/.venv`: Kokoro → whisper (4 beats cut on real pauses) → ffmpeg; output.mp4 11.37s vs VO 11.40s (one-frame sync). Suite 48/48.
   - Story tab UI + IPC bridge SHIPPED in BOTH surfaces: Next dev shell (commit `505062b`, `packages/studio/src/components/StoryStudio.jsx` — the one Luke sees; browser-verified) and Vite (commit `8c1432a`): `electron/lib/storyBridge.js` (story:* handlers, core in main process, venv override in userData/story-config.json), `window.story` preload, `src/components/StoryStudio.js` (create/open project, readiness banner + consented env install, gated stage buttons, script editor with word gate, scene rows: copy prompt / attach image / approve). Header nav is now Image · Video · Story · …; packages/core ships in the asar (build.files).
   - **Remaining for M3:** (a) **in-app click-test** (needs a human session): open Story tab → create project → paste script → voiceover → beats → attach/approve images → assemble → finalize. Dev tip: set venv via the banner to `/Volumes/My Lexar/AI Projects/Faceless YT 1/pipeline/.venv/bin/python`; (b) image source picker beyond manual attach (Google Flow NB2 free default — agent/manual until the Flow provider ships; NB2 *Pro* = explicit paid choice; Higgsfield MCP generate_image bills credits — explicit choice only) — per-scene **fal generation is DONE** (story:generate-scene, 'fal ⚡' button; default fal-ai/flux/schnell, override via story-config.json imageModel); (c) publish stage as a generic n8n-webhook route (Luke's Drive/tracker/Curio infra deliberately NOT vendored); (d) outro-slide step (skill's outro flow) not yet in the runner.
4. Then M4 CLI/MCP exposure (import @vidmyo/core from `mcp/server.js`), M5 agent session briefs, Flow browser provider (raised priority, Creator tier).

## Known debts / cautions

- Graphify graph is stale: `graphify update .` refuses (679 vs 715 nodes; baseline predates the deletions); the CLI has no force flag — needs a forced rebuild via the Python API (`force=True`). Don't guess CLI flags (logged mistake 2026-06-04).
- Next.js surface (`app/` + `packages/studio`) still ships its own deprecated catalog copy — harmless while frozen.
- `mcp/smoke.mjs` needs Video Delta running (`python -m videodelta.api`, port 7861).
- README download links point at v1.0.9 assets named `Open.Generative.AI-*` — correct until a new release is cut.
- `.env` exists at repo root: never read or print its values.
- Workspaces now include `packages/core`; `npm install` hasn't been rerun (not needed — the renderer imports core by relative path).
