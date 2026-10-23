# Editor — V1 engine + Custom templates (implementation spec)

Status: build spec, authoritative for the Editor capability.
Owner of the plan: Hermes (manager). Implementers read this file before touching code.

## 1. What the user asked for

- A new **Editor** section (desktop tab + MCP) in Vidmyo.
- Inside Editor, an engine named **V1** (future engines will join it, so the engine list must be data, not an if-chain).
- V1 ships two modes:
  - **Original** — the bundled "edutir-v1" documentary look, no examples needed.
  - **Custom** — the user pastes example URLs (YouTube) and/or picks example video files whose style
    they like; the analysis turns those examples into a **style profile** which can be saved as a
    reusable **template**; every run can then use a saved template.
- The agent path must work from a single sentence, e.g.
  `edituj mi footage located in folder XYZ` → MCP call with `input_dir=/Users/…/XYZ`.
- The UI must have **Browse** buttons for the **Input folder** and the **Output folder**.

## 2. The style engine that already exists

`packages/editor-engine/skill/` is the vendored `editor-v1` kit (HyperFrames + Python devices).
Proven working on this machine: renderer 0.8.72 (`node_modules/.bin/hyperframes`), Python 3.13
(numpy, cv2, soundfile, faster-whisper 1.2.1), GSAP vendored at
`packages/editor-engine/skill/assets/vendor/gsap.min.js`.

Vendored layout (do not restructure):

```
packages/editor-engine/skill/
  SKILL.md reference/ components/ scripts/ template/ assets/ sfx/ kit.json(?)
```

`components/ev1_devices.py` + `components/ev1_more.py` expose the device library and the `Comp`
class (`Comp.clip/video/at/cue/write/write_cues`). `template/build.py` shows the composition
contract: `data-composition-id`, `data-start`, `data-duration` per clip, GSAP timeline registered in
`window.__timelines`.

## 3. New files (exact paths)

```
packages/editor-engine/README.md                  vendored kit provenance + how the driver uses it
packages/editor-engine/driver/build_from_plan.py  plan.json -> comp/index.html + sfx-cues.txt + work/shots.json
packages/editor-engine/driver/analyze_examples.py examples -> style-profile.json (+ contact sheet)
packages/core/src/editor.js                       contract, options, project, service, template store
packages/core/src/editorEngines.js                ffmpeg/ffprobe/python/hyperframes engines (injectable)
packages/core/src/editorRunner.js                 resumable stage runner (job -> stages -> artifacts)
packages/core/test/editor.test.js                 mocked engines, contract + resume + template store
packages/core/test/editorModel.test.js            pure presentation model
mcp/lib/editorService.js                          bounded adapter over the core service
mcp/lib/tools.js                                  registerEditorTools(server, service) + ctx wiring
mcp/test/editorTools.test.js                      in-memory transport, at least one rejected input
electron/lib/editorBridge.js                      IPC handlers over the same service
electron/preload.js                               contextBridge.exposeInMainWorld('editor', {...})
electron/main.js                                  require + register() + stop() in the shutdown promise
packages/studio/src/editorModel.mjs               pure presentation logic (no React)
packages/studio/src/components/EditorStudio.jsx   the tab
packages/studio/src/index.js                      export EditorStudio
components/StandaloneShell.js                     TABS + TAB_ICONS + render line
```

## 4. Core contract (`packages/core/src/editor.js`)

```js
export const EDITOR_CONTRACT_VERSION = 1;
export const EDITOR_PROJECT_KIND = 'vidmyo.editor';
export const EDITOR_JOB_TYPE = 'editor';

// engine list is data so V2/V3 can be added without touching the UI
export const EDITOR_ENGINES = [
  { id: 'v1', name: 'V1', description: 'Documentary edit: real pictures, devices, click on every change.' },
];
export const EDITOR_MODES = ['original', 'custom'];

export const EDITOR_STAGES = ['probe','prepare','transcribe','assets','plan','build','render','mix','finish','validate'];
export const EDITOR_STAGE_DEPENDENCIES = { probe: [], prepare: ['probe'], transcribe: ['prepare'],
  assets: ['transcribe'], plan: ['assets'], build: ['plan'], render: ['build'],
  mix: ['render'], finish: ['mix'], validate: ['finish'] };
export const EDITOR_PROGRESS_LABELS = { probe: 'Inspecting footage', … };

export function planEditorStages(options)          // the project stage list
export function normalizeEditorOptions(input) // throws on invalid, returns frozen plain object
export function editorCapabilities()          // engines, modes, devices, ffmpeg/hyperframes/python availability

export class EditorProject   // <output>/<slug>-<stamp>/ : manifest.json, artifacts/, comp/, out/, work/
export class EditorTemplateStore // ~/.vidmyo/editor/templates/<id>/template.json (+ style-profile.json, examples/)
export class EditorService   // create({input, output, options}) -> {job, project}; retry; cancel; get
```

Stage artifacts (each stage writes exactly one of these; the runner skips stages whose artifact exists):
| stage | artifact |
|---|---|
| probe | `artifacts/probe.json` (duration, fps, streams, resolution, audio) |
| prepare | `work/cam_raw.mp4` (30 fps CFR, no filters) + `work/vo.wav` (16-bit 48 kHz) |
| transcribe | `artifacts/transcript.json` (`{words:[{w,s,e}], segments:[…]}` — word timestamps required) |
| assets | `artifacts/assets.json` (`{stills:[…], clips:[…], face:'work/cam_raw.mp4'}`) |
| plan | `artifacts/plan.json` (EDL: beats with `t0,t1,device,asset,captions,keyword`) |
| build | `comp/index.html` + `comp/sfx-cues.txt` + `work/shots.json` |
| render | `out/render.mp4` |
| mix | `out/mixed.mp4` (music bed + cue mix when `music_path` given, else copy of render) |
| finish | `out/final.mp4` |
| validate | `artifacts/validate.json` (durations, stream counts, loudness, re-transcript word recall) |

Retry semantics: a retry is a NEW job over the SAME project directory (see
`vitmyo-capability` skill: job states are terminal). Never revive a job.

### 4b. `artifacts/plan.json` — the shared contract between the planner and the driver

The Node planner writes it; `build_from_plan.py` reads it; the UI and MCP read it for review.
Paths are relative to the project directory. Times are seconds on the 30 fps frame grid.

```json
{
  "version": 1,
  "engine": "v1",
  "mode": "original",
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "duration": 42.5,
  "style": { "name": "V1 original", "cut_median_s": 0.79, "palette": ["#0f2a33"], "treatments": ["teal", "mono"] },
  "face": { "source": "work/cam_raw.mp4", "share": 0.3 },
  "beats": [
    { "id": "b1", "t0": 0.0, "t1": 1.4, "device": "tile_reveal", "asset": "assets/media/still_001.png",
      "treatment": "teal", "caption": [["This", 0.0], ["is", 0.3], ["real", 0.6]],
      "keyword": { "text": "REAL", "kind": "shock", "at": 0.8 } },
    { "id": "b2", "t0": 1.4, "t1": 2.6, "device": "broll", "asset": "assets/media/clip_002.mp4",
      "media_start": 0.0, "rate": 0.06, "caption": [["footage", 0.1], ["from", 0.35]] },
    { "id": "b3", "t0": 2.6, "t1": 4.0, "device": "face", "punch": [3.1, 1.08] }
  ]
}
```

Devices the driver must support (everything else falls back to `still`): `tile_reveal`, `still`,
`broll`, `face`, `seq`, `strobe`, `wall3d`, `pop_collage`. `keyword.kind` ∈ `key|title|shock|mega`
(`mega` is only meaningful on a `face` beat and needs the matte, so the driver must ignore `mega`
when no matte exists and fall back to `shock`). `caption` is `[[word, onsetSeconds], …]` in
absolute project time; `at` in `keyword` is absolute too. Asset paths that do not exist must make the
driver exit non-zero with a clear message (never silently render a blank frame).


## 5. Engines (`packages/core/src/editorEngines.js`)

`createEditorEngines({ ffmpeg, ffprobe, python, hyperframes, skillDir } = {})` returns:
`{ id:'editor-v1', probe, prepare, transcribe, collectAssets, plan, build, render, mix, finish, validate, analyzeExamples }`
plus `analyzeExampleVideos({ paths, workDir, signal })` (pure process work, no network) and
`downloadExample(url, dir)` (yt-dlp; reject non-URLs, cap duration/size).

Reuse:
- transcription: `packages/core/scripts/transcribe.py` (faster-whisper, `--word-timestamps`).
- probe/prepare/render: ffmpeg + ffprobe (see `translateEngines.js` for the governed-process pattern).
- render: `node_modules/.bin/hyperframes render comp -q <quality> -f 30 -o out/render.mp4`
  (do not call `npx`), `lint` first and fail the job on lint errors only.

`plan` is deterministic: transcript words + style profile → beats. Defaults for Original come from
`skill/reference/look.md` / `devices.md` (held shot median 0.79 s, 60–180 images/min, strobe bursts on
single words, face 25–35 % of runtime, caption 62 px Inter 600). A custom style profile overrides:
`shot_median_s`, `cuts_per_minute`, `burst_ratio`, `palette`, `treatment_mix`, `caption_size`.

`assets`: the input folder (recursively, video + image extensions) is the B-roll library; also accept
`options.examples` asset URLs the agent supplies. Never download anything the user did not name.

## 6. Custom mode / templates

`editor_analyze_examples` downloads (yt-dlp when a URL) and analyses frame by frame:
shot cut detection (frame-diff on downscaled grays, threshold ~0.35), shot length distribution
(median/p10/p90/mean), cuts-per-minute, burst ratio (shots < 0.2 s), palette (k-means on sampled
frames, top 6 hex + mean saturation/contrast/brightness), motion energy, aspect ratio, optional
transcript-derived words-per-minute. Writes `style-profile.json` + `contact-sheet.jpg`.

`EditorTemplateStore.save({name, profile, examples})` → id (slug + short hash), so the UI can offer
"Save as template" and every later run can pass `template_id`. Templates are user data, never inside
the repo: `~/.vidmyo/editor/templates/`.


### 6b. Brain — the optional semantic layer

V1 renders with **no AI at all**: probe → prepare → local Whisper → assets → deterministic planner →
HyperFrames → mix → finish. What the deterministic planner cannot do is know that "the harbour"
should show the harbour; it only rotates the material it finds. That single decision is what the
brain adds.

- `options.brain = { mode: 'none' | 'local', agent_id, timeout_s }`; default `none`.
- `local` runs one **headless turn of an agent CLI the user already has installed and logged in**
  (`packages/core/src/editorAgents.js`: opencode, hermes, codex, gemini, claude_code). The prompt is
  closed-world: the beats of the already-timed edit plus the footage inventory; the answer may only
  choose among those files and words that were actually said.
- The answer is validated (`parseBrainPicks`) before it touches the plan: unknown file, out-of-range
  beat, a keyword that was not spoken, two face beats in a row → dropped with a reason. The plan
  timing never comes from the agent.
- Any failure (agent missing, non-JSON answer, timeout) degrades to the deterministic plan with a
  warning; the edit still renders.
- Result is recorded in `artifacts/brain.json` (agent, applied counts, rejected entries, raw preview)
  and in the plan stage metrics (`brain_agent`, `brain_pictures`).
- **The Editor never uses the Direct API keys** configured for image/video generation, and has no
  API-key mode on purpose: the agent runs as the user's own CLI with its own login.
- MCP: `editor_start_edit { brain_agent: "opencode" }`; `editor_capabilities` lists the agents
  detection found on the machine.

## 7. MCP tools (names are part of the contract)

| tool | purpose |
|---|---|
| `editor_capabilities` | engines, modes, devices, local tool availability, template count |
| `editor_start_edit` | `{ input_dir, output_dir?, mode?, template_id?, music_path?, quality?, face_share?, pacing?, examples?[] }` → `job_id` |
| `editor_get_job` | state, stage, progress, outputs, warnings, timings |
| `editor_list_jobs` | recent editor jobs |
| `editor_cancel_job` / `editor_retry_job` | same semantics as translate |
| `editor_analyze_examples` | `{ urls?[], videos?[], name }` → job_id producing a style profile |
| `editor_list_templates` / `editor_save_template` / `editor_delete_template` | template CRUD |
| `editor_read_artifact` | bounded JSON artifact read (`plan.json`, `style-profile.json`, `validate.json`) |

`input_dir` and `output_dir` are absolute local paths; validate existence and that output is writable.
Return plain JSON from handlers (await before spreading — see the `vidmyo-capability` skill).

## 8. UI (Editor tab)

`EditorStudio.jsx` — one screen, non-technical:
1. **Engine** select: `V1` (driven by `EDITOR_ENGINES`).
2. **Mode** segmented control: `Original` | `Custom`.
3. **Footage**: Input folder row with **Browse…** (`window.editor.pickFolder('input')`), editable path.
4. **Output**: Output folder row with **Browse…** (`window.editor.pickFolder('output')`).
5. **Custom only**: example URLs (add/remove list), example video files (Browse…), **Analyze examples**
   button → progress, "Save as template" with a name field, saved-template list (apply/delete).
6. Options: quality, face share, pacing, music bed (Browse… file).
7. **Start edit** → job progress checklist per stage, warnings, **Open output folder** / **Reveal final.mp4**.
8. Empty/browser state: when `window.editor` is absent (web build) show a clear "available in the desktop app" note.

`editorModel.mjs`: pure functions `editorEngineOptions(capabilities)`, `describeEditorJob(job)`,
`stageChecklist(job)`, `validateEditorForm(form)` — unit-tested, no DOM.

## 9. Verification (must actually run)

1. `node --test packages/core/test/editor.test.js packages/core/test/editorModel.test.js`
2. `node --test mcp/test/editorTools.test.js`
3. `npm run lint` → 0 errors.
4. `npm run build` → compiles.
5. Real stdio MCP handshake: `listTools` includes every `editor_*` tool; one invalid call is rejected.
6. Real end-to-end edit on a generated 8 s talking-head fixture (ffmpeg `testsrc`+`sine`) through the
   production engines: `out/final.mp4` exists, 1920×1080, ≥ the take's duration, audio + video streams.
7. `graphify update .` after the change.

Report measured numbers from step 6; never present a mocked run as end-to-end.
