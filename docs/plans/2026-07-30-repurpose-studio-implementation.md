# Vidmyo Repurpose Studio implementation plan

Status: planning draft for `/finn-spec` refinement. No implementation is authorized by this document alone.

## 1. Outcome

Add a first-class **Repurpose** studio to Vidmyo. A user imports a long-form video or supported URL, Vidmyo finds strong self-contained moments, explains why each moment was selected, lets the user approve or adjust candidates, then renders platform-ready vertical clips with smart framing and captions.

This is more than a hidden module in the product, but less than a separate product today:

- **Product surface:** a visible `Repurpose` tab in Vidmyo.
- **Engine:** a swappable local Python package under the Vidmyo repository.
- **Orchestration:** existing `@vidmyo/core` jobs, artifacts, Electron bridge, and MCP patterns.
- **Future option:** expose the same engine through a CLI or service without rewriting the pipeline.

## 2. User journey

1. Open **Repurpose**.
2. Choose a local video or paste a supported source URL.
3. Select output target: YouTube Shorts, TikTok, Instagram Reels, or custom aspect ratio.
4. Choose desired clip count and broad content type, or leave content type on Auto.
5. Start analysis. Vidmyo shows durable stage progress and can resume after restart.
6. Review ranked candidates. Each candidate shows:
   - video preview;
   - start/end time and duration;
   - score and confidence;
   - proposed hook/title;
   - score breakdown;
   - plain-language selection reason.
7. Approve, reject, trim, or reorder candidates.
8. Choose crop mode and caption style, then render.
9. Preview final clips and reveal/export files. Publishing is a later gated phase.

## 3. MVP scope

### Included

- Local file input first, plus YouTube URL input through `yt-dlp` when legally and technically available.
- Speech-focused content: podcasts, interviews, lectures, webinars, commentary, and talking-head videos.
- Local transcription with `faster-whisper`, word-level timestamps, and optional source subtitles when usable.
- Candidate generation from transcript windows aligned to sentence/word boundaries.
- Explainable ranking using transcript, audio, and lightweight visual signals.
- Temporal and semantic deduplication.
- Human approval and manual boundary adjustment before rendering.
- Smart 9:16 reframing for one or two speakers, with a safe blurred-background fallback.
- Burned-in captions with at least two styles.
- Durable jobs, cancellation, restart/resume, logs, and artifacts.
- Local output with YouTube Shorts, TikTok, and Instagram presets.
- MCP read/start/status tools after the desktop flow is stable.

### Explicitly not in the MVP

- Fully automatic publishing without approval.
- Training a proprietary virality model.
- Claiming that a score predicts actual virality.
- Sports/game highlight specialization.
- Multi-source narrative assembly or AI-generated B-roll.
- Voice dubbing, translation, thumbnails, content calendars, or social scheduling.
- A hosted Vidmyo cloud processing service.
- Copying unlicensed or AGPL code into Vidmyo.

These are expansion tracks, not reasons to delay the core clip-selection loop.

## 4. Repository structure

Keep everything inside the existing Vidmyo repository:

```text
Vidmyo/
├── packages/
│   ├── core/
│   │   ├── src/repurpose.js
│   │   ├── src/repurposeRunner.js
│   │   └── test/repurpose.test.js
│   ├── repurpose-engine/
│   │   ├── pyproject.toml
│   │   ├── src/vidmyo_repurpose/
│   │   │   ├── cli.py
│   │   │   ├── contracts.py
│   │   │   ├── ingest.py
│   │   │   ├── transcribe.py
│   │   │   ├── candidates.py
│   │   │   ├── ranking/
│   │   │   ├── boundaries.py
│   │   │   ├── reframe.py
│   │   │   ├── captions.py
│   │   │   └── render.py
│   │   └── tests/
│   └── studio/
│       └── src/components/RepurposeStudio.jsx
├── electron/
│   └── lib/repurposeBridge.js
├── mcp/
│   └── lib/tools.js
└── docs/
    ├── plans/
    └── repurpose/
```

`packages/repurpose-engine` is a Python package, not an npm workspace. Node launches it as a worker process with a versioned JSON request/progress protocol. Do not add an always-running local HTTP server for the MVP. A spawned worker is simpler, avoids port conflicts, and naturally belongs to the Electron lifecycle.

## 5. Architecture boundaries

### Renderer

`RepurposeStudio.jsx` displays state and sends commands. It never reads arbitrary files, runs Python, stores provider keys, or performs heavy media processing.

### Electron main process

`electron/lib/repurposeBridge.js` owns native file selection, safe path validation, process lifecycle, progress events, cancellation, and reading approved artifacts for preview.

### Core orchestration

`packages/core/src/repurpose.js` defines the manifest and pure state transitions. `repurposeRunner.js` maps engine stages onto `JobStore` and artifacts. Follow the existing Story and cloud-generation patterns instead of inventing another job system.

### Python engine

The engine performs deterministic media work and model inference. It accepts a JSON job document, writes versioned JSON artifacts, emits JSONL progress, and exits with a meaningful code. Each completed stage is cacheable and independently testable.

### Durable project state

Each repurpose project has a manifest containing source fingerprint, engine version, transcript artifact, candidate set, approvals, render settings, and final outputs. Job records remain in the existing `JobStore`; project artifacts live in a project-specific directory and are referenced by path.

## 6. Engine stages and contracts

### Stage A: ingest

Inputs: local path or supported URL.

Outputs:

- normalized local source path;
- `ffprobe` metadata;
- source fingerprint;
- optional downloaded subtitle tracks;
- validation errors for unsupported, missing, protected, or audio-less media.

The source fingerprint prevents accidental duplicate downloads and invalidates downstream caches when the source changes.

### Stage B: transcription

Use `faster-whisper` with word timestamps. Normalize output to one stable schema:

```json
{
  "language": "en",
  "duration": 3600.2,
  "segments": [{"start": 0.2, "end": 3.8, "text": "..."}],
  "words": [{"start": 0.2, "end": 0.6, "text": "...", "confidence": 0.97}]
}
```

Source subtitles may accelerate analysis, but only Whisper-quality word timing can drive final cuts and karaoke captions.

### Stage C: candidate generation

- Build overlapping transcript windows aligned to real segment boundaries.
- Detect complete thoughts, story arcs, strong claims, useful tips, emotional peaks, conflict, revelations, quotable lines, and payoffs.
- Adapt prompt/rules by content type and information density.
- Generate more candidates than requested so ranking and dedupe have room.
- Store the exact evidence span used to propose each candidate.

LLM calls must be provider-pluggable. Gemini can be the first supported provider because Vidmyo already understands BYOK providers, but candidate contracts must not depend on Gemini-specific output.

### Stage D: multi-signal ranking

Do not use one opaque “viral” number. Keep these component scores:

- hook strength in the first three seconds;
- standalone coherence;
- information density and novelty;
- emotional or vocal dynamics;
- visual motion/scene activity;
- narrative arc and payoff;
- context independence;
- duration fitness;
- confidence and evidence quality.

Combine deterministic features with structured LLM judgments. Calibrate the final score to `0–100`, but present it as **clip potential**, not a prediction of views.

After scoring:

- reject candidates that start/end mid-thought;
- suppress candidates with excessive temporal overlap;
- use semantic similarity to avoid several clips saying the same thing;
- use a diversity-aware top-N selection so results cover different moments.

### Stage E: boundary repair

Snap starts and ends to word boundaries and nearby silence. Preserve minimum and maximum duration rules without cutting a word or losing the payoff. Store both proposed and repaired boundaries for auditability.

### Stage F: reframing

MVP crop modes:

1. Track the active speaker in a 9:16 crop.
2. Split-screen for two visible speakers.
3. Blurred-background fallback when tracking confidence is low.

Use smoothing, dead zones, and minimum hold durations to prevent camera jitter. Never silently choose an unstable crop; fall back and record why.

### Stage G: captions and render

- Generate captions from word timestamps.
- Render at least Clean and Bold styles.
- Derive backing size from actual rendered text pixels so padding stays even.
- Apply platform presets through FFmpeg.
- Preserve an intermediate master and separate platform exports.
- Validate outputs with `ffprobe` before marking the job done.

## 7. Ranking and quality strategy

Use the repositories as references, not as one wholesale dependency:

- **OpenShorts, MIT:** pipeline structure, word-boundary repair, scene-aware windows, testing patterns.
- **ClipsAI, MIT:** transcript segmentation and speaker-aware reframing concepts; evaluate whether direct dependency or selective clean-room implementation is safer.
- **Trimora V2, MIT:** staged ranking, confidence weighting, narrative/context gates, and diversity optimization.
- **OpenSource Clipping, MIT:** caption, crop, hook, and render feature ideas; avoid importing its whole pipeline.
- **Lighthouse, Apache-2.0:** optional future visual/audio saliency signal, not an MVP dependency because of duration and model complexity.
- **AI YouTube Shorts Generator:** requirements inspiration only until its license is clarified.
- **HotClip, AGPL-3.0:** do not copy or link into Vidmyo's proprietary distribution.

Create `docs/repurpose/THIRD_PARTY.md` before importing code. Record repository, commit, license, files/concepts used, modifications, and required notices.

## 8. Desktop experience

Add `{ id: 'repurpose', label: 'Repurpose' }` to `components/StandaloneShell.js` and render `RepurposeStudio` from `packages/studio`.

The screen should have four states:

1. **New project:** input, target platforms, clip count, language/content controls.
2. **Analyzing:** stage timeline, progress, elapsed work, cancel, and resume messaging.
3. **Review:** candidate list with preview, score breakdown, reason, boundary editor, approve/reject.
4. **Rendered:** final previews, output paths, reveal/export actions, and rerender controls.

Empty, failed, cancelled, and partially completed projects must reopen without losing accepted work.

## 9. MCP and agent surface

Add MCP tools only after the desktop flow and contracts are stable:

- `repurpose_create`
- `repurpose_analyze`
- `repurpose_get`
- `repurpose_list_candidates`
- `repurpose_set_candidate_decision`
- `repurpose_render`
- `get_repurpose_job`

Long operations return a job identifier quickly. Status and artifacts are polled from disk-backed jobs, matching Vidmyo's existing asynchronous video generation pattern. Agents may analyze and prepare candidates, but publishing remains a human gate.

## 10. Error and rescue behavior

| Failure | User-visible behavior | Rescue path |
|---|---|---|
| Download blocked or URL unsupported | Explain that the source could not be imported | Let the user choose a local file without losing settings |
| No speech detected | Stop after transcription | Offer manual time-range clipping; do not fabricate candidates |
| LLM unavailable or malformed output | Preserve transcript and retry budget | Retry structured output, switch configured provider, or resume later |
| Face tracking confidence low | Mark crop as fallback | Use blurred background or manual crop anchor |
| Worker/app closes mid-stage | Job remains incomplete, not failed by assumption | Resume from last validated artifact |
| Render fails | Preserve approved candidates and intermediates | Retry only the failed candidate/render stage |
| Source file changes | Block stale cache use | Re-ingest and invalidate dependent artifacts |
| Disk space is insufficient | Fail before expensive render | Show required/free space and preserve analysis |

Every error must say what failed, what work is preserved, and what the next action does.

## 11. Verification gates

Build a small local benchmark set of five legally usable long-form videos covering one-person talking head, two-person podcast, lecture, low-motion webinar, and a visually active clip.

MVP acceptance targets, to be confirmed during `/finn-spec`:

- Across five benchmark videos, the top five candidates contain at least three human-approved clips in at least four videos.
- Zero mid-word cuts across 25 rendered benchmark clips.
- No candidate begins or ends with an obviously incomplete sentence in the approved benchmark set.
- Temporal/semantic dedupe produces no near-duplicate pair in the final top five.
- Primary speaker stays inside the configured safe zone for at least 95% of sampled frames in the talking-head benchmark; low confidence must trigger fallback.
- Killing the worker during every major stage and reopening Vidmyo never reruns an already validated stage unnecessarily.
- Every rendered file passes `ffprobe` validation for codec, aspect ratio, duration, and audio presence.
- Core state tests, Python unit tests, bridge tests, and the existing root test suite all pass.

Do not claim ranking quality from star counts or demos. Save benchmark decisions and score breakdowns so weights can be tuned from evidence.

## 12. Build sequence for Finn-loop

Each issue below should be one day of agent work or less and use merged work from previous issues.

### Issue 1: contracts and engine skeleton

- Python package, JSON schemas, versioned worker protocol, fixtures, and basic CLI.
- Core manifest/state transitions and tests.
- No transcription, ranking, UI, or rendering.

### Issue 2: ingest and media validation

- Local files, `ffprobe`, fingerprints, optional URL download adapter, error cases, and cache invalidation.

### Issue 3: transcription artifact

- `faster-whisper`, normalized word/segment schema, model setup/doctor, progress, cancellation, and fixtures.

### Issue 4: candidate generation

- Windowing, content classification, provider-pluggable structured LLM call, evidence spans, retry/validation, and long-video chunking.

### Issue 5: explainable ranking and dedupe

- Component scoring, confidence, hard gates, overlap suppression, semantic diversity, score breakdowns, and benchmark harness.

### Issue 6: boundary repair and clip extraction

- Word/silence snapping, duration constraints, FFmpeg extraction, deterministic tests, and no-mid-word benchmark.

### Issue 7: smart reframing

- Face/speaker detection, smoothing, one-speaker crop, two-speaker mode, confidence thresholds, and fallback.

### Issue 8: captions and platform render

- Caption contracts, Clean/Bold styles, pixel-bound backing, master render, platform presets, and `ffprobe` verification.

### Issue 9: Electron bridge and durable jobs

- File picker, spawned worker, JSONL progress, JobStore integration, cancellation, restart/resume, safe preview reads, and preload surface.

### Issue 10: Repurpose Studio UI

- Tab registration, new/analyzing/review/rendered states, candidate preview, decisions, boundary controls, error/rescue screens, and reopen behavior.

### Issue 11: MCP tools and documentation

- Async tools over stable contracts, human publishing gate, README/doctor instructions, third-party notices, and agent examples.

### Issue 12: end-to-end hardening

- Five-video benchmark, crash/restart tests, performance measurements, packaging check, regression fixes, and release-readiness report.

`/finn-spec` should interview and file these as a dependency chain, starting with Issue 1. It must not apply `agent-ready`; Luke applies that label only after reading each issue.

## 13. Decisions for the `/finn-spec` interview

The implementation task must ask Luke, in outcome language:

1. Is the first release local-file only, or local file plus YouTube URL?
2. Are candidates always approved manually before rendering, or can a user opt into automatic top-N rendering?
3. Is the first customer a podcaster/interviewer, or should lectures/webinars receive equal optimization?
4. Which output platforms must ship first?
5. Should candidate boundaries be editable with numeric controls only, or a visual timeline in the MVP?
6. Are Gemini and local inference both required at launch, or is one provider enough behind a pluggable contract?
7. Where should project files live by default, and should users choose a folder?
8. Which caption styles are mandatory?
9. Is publishing explicitly deferred, or must YouTube upload be part of the first commercial release?
10. What benchmark result is good enough for Luke to trust the ranking?

## 14. Rollout

1. **Internal alpha:** local files, analysis, manual approval, one-speaker crop, captions, local export.
2. **Private beta:** two-speaker mode, URL ingest, benchmark tuning, restart/resume proof.
3. **Creator release:** polished failure recovery, platform presets, documentation, MCP tools.
4. **Later:** publishing, scheduling, dubbing, translation, B-roll, thumbnails, team collaboration, and a standalone service wrapper if demand proves it.

## 15. Definition of plan completion

This plan is ready for implementation only after:

- `/finn-spec` resolves the product decisions above;
- the first issue contains stable `AC-N` acceptance criteria and `NG-N` non-goals;
- relevant file paths and tests are named;
- GitHub-side Finn labels and CI requirements are checked in the Vidmyo project session with explicit authorization before any remote mutation;
- Luke reviews the Linear issue and personally applies `agent-ready`.

Humans merge. The build loop never merges or expands scope beyond the approved issue.
