# Story and Animations — implementation and acceptance plan

Status: execution plan, 2026-09-15. Owner: Codex integration; execution delegated to GPT-5.6 after this plan is complete.

## 1. Outcome and scope

Build two complete, approachable video workspaces in the existing Electron/Next.js app:

1. **Story:** start with an idea or explicitly selected Google Sheets row. User supplies a brief and chooses a connected local agent or API. Script and voiceover review are optional. The remainder runs automatically, saves progress, produces a playable video and can be reopened.
2. **Animations:** choose a visual style first, then brief, duration, landscape/portrait and agent. Same durable create/reopen/review/production/preview experience.

Preserve the existing dirty checkout and unrelated work. No commits, pushes, user media modifications, real paid generation, or publishing are needed to implement/test this change.

## 2. Evidence from source inspection

Source: `/Volumes/My Lexar/AI Projects/ Remotion Animations 2`.

| Style | Evidence | Distinctive behavior |
|---|---|---|
| Editorial collage | empire-downfall-project-pack/SPEC.md and 7 component scenes; final video is 1920×1080, 47.3s | Fixed paper base, photographic cutouts, red offset silhouettes, foreground anchors, animated typography/charts, narration-driven timing |
| Documentary maps | skool-practice-kit/BUILD-PROMPTS.md, START-HERE.md; master is 1920×1080, 31.06s | Real geography, country/location emphasis, routes and continuous camera movements, documentary palette |
| Paper stop-motion | MASTER GPT PROMPT…docx | One hero, at most 2–3 supporting objects, thick layered cardstock, fixed camera, back-to-front assembly for first 70%, living-poster hold for final 30% |

There are **three styles**, not separate long/short duplicates. Both supplied finished examples are landscape and short. Individual scenes are not independent style choices. Paper is a prompt specification, not an existing runnable Remotion project. Landscape/portrait and duration are independent settings. Existing faceless doodle remains Story's visual treatment.

Licensing: skool kit media expressly personal practice only. Do not bundle supplied third-party media or copy its example geopolitical claims into default user projects. Implement original treatments and retain provenance. World-atlas geometry is ISC/Natural Earth public-domain-derived; include required notice.

Video https://www.youtube.com/watch?v=2el_3pwqxyI, 1:40–3:40: watch skill retrieved captions and all 14 selected frames were viewed. Relevant concept: ordinary form with idea/motion/duration/style; agent backend; preview and persistent workspace history. This informs product flow, not code copying.

Current faults:

- New Project calls browser prompt() after native folder picker. Electron does not support window.prompt; invocation aborts before creation. Open Existing repeats this broken path when folder is empty.
- Story hardcodes a channel tracker and fixed columns; selectable Sheets/account UX is absent.
- Seven manual production stages expose pipeline internals and block the desired automatic flow.
- Existing code has reusable project manifests, local agent detection, encrypted keys, structured local/API providers, media streaming, Kokoro/beat extraction and app-owned Remotion runtime.

## 3. Product design

### Shared frame

- Keep existing app themes and navigation; add public **Animations** next to Story, route `/studio/animations`.
- Bounded internal scroll; no horizontal overflow at 390px, usable at 1024×640, balanced two-column desktop at 1440px.
- Header: concise promise, New video, Open existing. Main left = configuration; right = preview/progress/recent work.
- Native folder selection only chooses storage. Topic and all details are ordinary form inputs. No window.prompt/confirm for form entry, no silent failures.
- Inline error/status with clear next action; actions have pending states and synchronous duplicate-click guards.
- Persist recent projects on disk. Import legacy recents once without losing them. Invalid/missing project errors must not silently create new projects.

### Story intake

- Source choice: **My idea** / **Google Sheets**, no auto-loading of a channel tracker.
- My idea: topic/title, detailed brief (audience/angle/tone/CTA can be described together), language, target duration, landscape/portrait.
- Google Sheets: explicit Connect Google (or detected connected identity), choose spreadsheet, choose worksheet, refresh/load rows, searchable/selectable rows with title/status/hook/description. Shared-link alternative. Selected row fills the same editable brief; no writes back to the source sheet.
- Selecting/reselecting a source clears stale rows/tab/selection and avoids async races. Selected spreadsheet/worksheet/source-row metadata must survive project reopening.
- Source column names map common title/status/hook/description variants with current Curio/Superius layout as fallback; read more than fixed 60 rows and disclose limits.

### Animations intake

- First visual choice: three attractive style cards with original preview art and concrete descriptions.
- Separate landscape/portrait and target duration; presets Short (e.g. 30s) / Long (e.g. 480s) may fill numeric duration.
- Brief: topic and motion/visual details; narration toggle (paper defaults off to match its reference), language; optional supplied script.
- Clarify style cards are treatment previews; final generated visuals depend on prompt/assets.

### Agent/provider choice

- Local agent/API selector consistent with VFX/Cleaner: Codex, Claude Code, Gemini, Hermes, or OpenRouter + explicit model.
- Display detected connected state; unavailable agents disabled with Settings/Agents action; never silently change provider.
- Keys remain encrypted in global Settings; never write them into project JSON or send them to local provider subprocesses unnecessarily.
- Automatic images: choose actual API source/model and use saved keys. Google Flow has no callable generation API, so do not label it automatic. Map-only animations can render without an image API.
- Provider billing/data-sharing confirmation belongs at start of actual provider use. No repeated approval per internal stage. Resume must not re-bill completed assets.

### Optional review and production

- Two toggles only: Review script, Review voiceover. No obligatory scene/image/assemble approvals.
- State machine: draft → writing → [review-script] → voiceover → [review-voiceover] → planning → images → rendering → done. Narration-off skips voiceover. Error/cancel state retains durable completed stages.
- Continue after review approves that content and proceeds automatically. Script edits invalidate downstream voice/timing/plan/assets as needed; provider changes alone do not destroy existing work.
- No early image spending before script/voice review. Generate missing outputs only. Cancel ends local children and stops subsequent provider work; explain if an already-submitted remote job cannot be revoked.
- Reopen during/after production shows correct current state and saved output; app restart converts abandoned in-progress work into a resumable interrupted state.
- Progress is project-scoped; events cannot leak into another open project's UI. Output opens inline with native controls and Reveal folder.

## 4. Architecture and contracts

### Ownership and modules

- UI executor: `packages/studio/src/components/StoryStudio.jsx`, new `CreativeStudio.jsx`, `AnimationsStudio.jsx`, shared CSS/model if useful; `packages/studio/src/index.js`, `components/StandaloneShell.js`, `electron/preload.js`.
- Google/lifecycle executor: `electron/lib/storySheets.js`, Google helper modules if needed, targeted fixes in `electron/lib/storyBridge.js`; tests limited to these modules. Do not modify `creativeBridge.js`.
- Production executor: `electron/lib/creativeBridge.js`, `packages/core/src/animation.js`, `packages/animation-engine/**`, `packages/repurpose-engine/src/vidmyo_repurpose/creative.py`, focused tests. Do not modify UI/preload/main/storySheets.
- Root integrator: `electron/main.js`, packaging in `package.json`, cross-area contracts, independent verification, documentation and memory. Root may fix integration defects after coordinating ownership.

### Stable preload contract

`window.creative`:

- `isElectron: true`
- `pickRoot() -> {ok, dir, canceled?}`
- `create({root,brief}) -> snapshot`
- `open(dir?) -> snapshot` (absent dir opens picker; legacy recents may need a migration helper)
- `recent() -> {ok,projects:[{dir,title,kind,style,updatedAt}]}`
- `get(dir) -> snapshot`
- `save(dir,brief) -> snapshot`
- `start(dir,{approve?:boolean}) -> snapshot` resolves at review/completion/error
- `cancel(dir)`, `reveal(dir)`
- `onProgress(callback) -> unsubscribe`, event `{dir,message}`

Snapshot: `{ok,dir,manifest,busy,previewUrl?,voiceUrl?,error?}`. Manifest uses existing `project.json` v1 with `brief`, `script`, `voiceover`, `renders`, and additive `production:{state,message,output,scriptApproved,voiceApproved,...}`.

Brief: `{kind:'story'|'animation',style,topic,details,aspect:'16:9'|'9:16',durationSec,language,provider:{id,model},narration,reviewScript,reviewVoiceover,imageSource,imageModel,script,sourceSheet?}`. Preserve source metadata. Legacy projects normalize missing fields without losing media/script.

Additional `window.story` methods:

- `googleAccount() -> {ok,connected,email,canConnect,hint?}`
- `googleConnect() -> account result`
- `googleSheets(pageToken?) -> {ok,files:[{id,name}],nextPageToken}`
- `sheetTabs(id) -> {ok,title,tabs:[{sheetId,title}]}`
- `chooseSheet(input URL or {id,url?,tab}) -> {ok,sheetId,tab}`
- `selectedSheet() -> {ok,id,tab}`
- `readSheet() -> {ok,sheetId,tab,rows:[{row,title,status,videoNum,hook,topic}],via}`

Changes to this contract must be messaged to root and relevant executor before editing.

### Rendering and asset strategy

- Reuse app-owned Remotion installation, isolate each render's code/props/assets in its project. Do not execute AI-authored JS or arbitrary URLs.
- Director returns strictly validated JSON using existing tool-free local/API boundary. Stable scene IDs, safe internal assets, capped plan size/timing and bounded image count.
- Timings must cover full narration including pauses and tail; don't truncate audio to last recognized word. Frame count based on accumulated timing, no rounding drift.
- Maps use actual bundled geography with valid lat/lon, animated routes and camera continuity; preserve previous shot final camera at cuts.
- Collage should animate genuine visual layers where practical. Paper must honestly match supported capabilities; the current pre-plan draft's horizontal-band reveal is only a prototype and must be replaced/improved or explicitly identified as a limited approximation, never sold as object-aware assembly.
- Doodle Story retains its style lock. Render both aspect ratios correctly without applying a hardcoded 16:9 crop.
- Narration language must be actually supported by the chosen local engine; never quietly read Polish using an English voice. Validate supported language/voice or give a selectable supported engine path.
- Verify finished output dimensions, FPS, frame/duration coverage and audio presence; final output is not done until checks pass.

### Google authentication

- Current machine has authenticated gws; use existing connection without exposing token data.
- Product needs real Connect Google behavior. Prefer supported native browser OAuth/PKCE with encrypted tokens if app credentials are available; existing gws path can be a compatible integration. Do not fabricate credentials, claim login success or force sharing private sheets publicly.
- If distributable OAuth client provisioning is absent, document the exact release dependency; provide working existing-account/shared-link paths. Investigate before concluding a blocker. No account sign-out during tests.
- Google API operations are read-only; network errors, missing scope, revoked auth, empty sheets and pagination have clear UI states.

## 5. Execution sequence

1. Completed discovery above; write this plan and ownership/contracts first.
2. Dispatch three GPT-5.6 workers, each on its bounded file set. Existing drafts are input, not accepted implementation.
3. Root registers new bridge, packaging, checks connected boundaries, prepares browser and synthetic render checks while workers implement.
4. Reconcile outputs and contracts. Each worker reports tests and known limitations; root independently checks integrated behavior.
5. Fix defects, run relevant full core tests and focused Python tests, Studio/Next builds.
6. Refresh Graphify once final code settles. Append daily/shared memory with real evidence and any limitations.

## 6. Acceptance checklist

### Projects/UI

- [ ] Create from filled form + selected folder creates a unique subfolder and opens it; no prompt/confirm.
- [ ] Open existing valid new and legacy project works; cancel is quiet; invalid folder errors visibly without overwriting.
- [ ] Recent projects survive reload and app restart; no silent failure due to localStorage.
- [ ] Story idea and Sheets paths both fill same brief; optional reviews only; generated project can be reopened.
- [ ] Animations exposes exactly three separate styles and independent aspect/duration.
- [ ] Agent/API/source settings are effective, persisted and restored.
- [ ] Keyboard labels, errors, pending states and 390px/1024px/1440px scroll/layout verified.

### Google

- [ ] Connected identity read without printing tokens; list sheets, choose tab, select row.
- [ ] Shared-link alternative works; no hardcoded default queue; no source writes.
- [ ] Error/empty/disconnected/paginated/stale selection cases tested with fixtures.
- [ ] Live read-only account/list/tab/row probe where authorized credentials permit; no OAuth account changes for tests.

### Production

- [ ] Deterministic test double proves script-review, voice-review, no-review, narration-off, error and resume paths.
- [ ] Cancel prevents later stages, duplicate start blocked, path traversal/symlink escape rejected.
- [ ] Completed images survive retry without repeat paid generation.
- [ ] Legacy fields normalize safely; script/spec edits invalidate stale products.
- [ ] Real local synthetic render for all three animation styles + Story in landscape and portrait, using test imagery/no paid requests.
- [ ] Actual output inspected visually, frame/duration/audio checks pass, tests do not claim a mocked generation is a live provider run.
- [ ] No new code depends on developer-specific absolute paths; required runtime/provisioning limitations documented.

## 7. Initial risk register

- Existing dirty Story and bridges: preserve edits; no reset/revert/blanket checkout.
- Google client provisioning may be incomplete for distribution; distinguish local functioning integration from release readiness.
- Paper source is generative video guidance, not existing code. Exact quality requires real layers or generated video, not a generic slideshow. Inspect real synthetic outputs and describe limitations honestly.
- Provider calls billed: verify with mocks and local synthetic assets during implementation; do not incur live spend merely to validate plumbing.
- Legacy project manifests have no new brief/provider metadata; opening must succeed and ask for only genuinely missing configuration before a new run.
