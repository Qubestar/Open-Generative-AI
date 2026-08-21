# Vidmyo Repurpose engine contracts

This package is the versioned contract boundary and staged worker for Vidmyo
Repurpose. It requires Python 3.10 or newer. Local ingest also
requires `ffprobe` from FFmpeg to be available on `PATH`; it does not download,
copy, reframe, render, or upload source media.

Install for development and tests:

```bash
python3 -m pip install -e '.[test]'
python3 -m pytest
```

Validate a versioned request or project manifest:

```bash
vidmyo-repurpose validate --kind request tests/fixtures/valid-worker-request.json
vidmyo-repurpose validate --kind manifest tests/fixtures/valid-project-manifest.json
```

Exercise the JSONL protocol without doing media work:

```bash
vidmyo-repurpose smoke --request tests/fixtures/valid-worker-request.json
```

Ingest the `local_file` source named by `<project-dir>/repurpose.json`:

```bash
vidmyo-repurpose ingest --request /path/to/ingest-request.json
```

The request must use stage `ingest` and point `project_dir` at the caller's
Repurpose project. A successful run emits ordered version-1 JSONL events and
atomically writes `artifacts/ingest-artifact.v1.json` inside that project.
The artifact contains normalized ffprobe metadata and a streaming SHA-256
fingerprint; the source file itself is never copied or modified. The reserved
`url` source contract remains valid, but execution returns
`url_ingest_not_implemented` without making a network request.

The authoritative version-1 schemas live in `schemas/`.

## Local transcription model setup

Transcription uses `faster-whisper` 1.2.x with word timestamps. Its balanced
multilingual default is model `small`, automatic language detection, device
`cpu`, and compute type `int8`. A version-1 transcribe request may override
`model`, `language`, `device`, `compute_type`, and `model_cache` with validated
values. The normalized transcript contract does not change.

Readiness checks are read-only and never download or modify a model:

```bash
vidmyo-repurpose doctor --model small
```

The JSON result reports dependency and model readiness, the resolved cache,
and—when setup is needed—the exact command to run. Model download is permitted
only through that explicit command:

```bash
vidmyo-repurpose setup-model --model small
```

Use `--model-cache /custom/path` on doctor/setup, or `model_cache` in the
transcribe request, for a custom installation. A missing or incomplete model
causes transcribe to return `transcription_model_not_ready`; it never silently
downloads. `setup-model` downloads into staging, verifies the model can be
opened locally, and only then marks the deterministic cache ready.

After a completed ingest, submit a version-1 request whose stage is
`transcribe` and whose `input_artifacts` names that project's completed
`ingest_artifact` version 1:

```bash
vidmyo-repurpose transcribe --request /path/to/transcribe-request.json
```

Success atomically writes
`artifacts/transcript-artifact.v1.json` and emits ordered version-1 JSONL
events. An exact source/settings match produces an observable cache hit without
loading faster-whisper or rewriting the artifact. Cancellation, source drift,
invalid backend output, inference failure, or write failure emits a terminal
error with preservation and retry guidance; the completed ingest and any prior
valid transcript remain intact. No-speech input completes with
`speech_detected: false` and empty segment/word arrays.

Automated tests inject all model/download/inference boundaries. They do not
download models, access the network, require a GPU, or transcribe real media.

## Five-scenario release benchmark

The benchmark contract always contains exactly one talking-head, two-speaker,
lecture, webinar, and visually active scenario. Generate the offline mechanical
fixture corpus and report with:

```bash
vidmyo-repurpose benchmark-fixtures --output /tmp/vidmyo-benchmark
vidmyo-repurpose benchmark \
  --manifest /tmp/vidmyo-benchmark/benchmark-corpus.v1.json \
  --output /tmp/vidmyo-benchmark/report
```

The generated media is deterministic local FFmpeg color-and-tone material. It
can validate artifact contracts, metrics, FFprobe export checks, and reporting,
but its quality status is always `unknown`. Only licensed `human_real` evidence
from all five categories can satisfy the quality gate. See
`docs/repurpose/benchmark/README.md` for the corpus contract and intake rules.

## Transcript-grounded candidate suggestions

After a completed version-1 transcript, submit a `generate_candidates` worker
request naming `artifacts/transcript-artifact.v1.json` and an explicit
OpenRouter model:

```json
{
  "protocol_version": 1,
  "job_id": "job_candidates_001",
  "project_dir": "/path/to/repurpose-project",
  "stage": "generate_candidates",
  "input_artifacts": [{
    "kind": "transcript_artifact",
    "path": "artifacts/transcript-artifact.v1.json",
    "version": 1
  }],
  "options": {"provider": "openrouter", "model": "openai/gpt-4.1-mini"}
}
```

Set `OPENROUTER_API_KEY` only in the worker environment, then run:

```bash
vidmyo-repurpose generate-candidates --request /path/to/request.json
```

The key is sent only in the OpenRouter authorization header. It is never
written to the request, project, candidate artifact, project-local cache,
progress stream, or bounded error detail. The adapter is non-streaming and
requires strict JSON Schema support from the explicitly selected model and
route; it never switches to another provider or paid model.

Candidate generation uses deterministic 1,500-word, segment-aligned windows
with a segment-expanded 300-word overlap. `auto` content type classifies
deterministic beginning/middle/ending transcript samples; explicit podcast,
interview, lecture, webinar, commentary, and talking-head settings skip that
call, while uncertain or unsupported speech uses `general_speech`. Proposed
spans must reference exact transcript words and span 20–120 seconds. Evidence
text and timestamps are reconstructed locally rather than trusted from model
text.

Each structured call has one attempt and at most two fixed-delay retries.
Validated classification/window results are atomically cached under the
project so a corrected retry can preserve earlier paid work. A matching final
artifact is a no-call, no-rewrite cache hit. Cancellation preserves the
transcript, completed window caches, and any earlier valid candidate artifact.
A speech transcript with no worthwhile suggestions completes with
`no_candidates_found`; a no-speech transcript stops with
`candidate_no_speech` before provider construction.

The artifact contains proposed candidates only. It does not score, rank,
deduplicate, repair boundaries, approve, select, extract, render, or publish.
Automated candidate tests use injected providers and HTTP boundaries and never
use an API key or network request.

## Explainable candidate ranking and deduplication

After candidate generation completes, submit a `rank` request naming both the
current transcript and candidate artifacts:

```json
{
  "protocol_version": 1,
  "job_id": "job_rank_001",
  "project_dir": "/path/to/repurpose-project",
  "stage": "rank",
  "input_artifacts": [
    {
      "kind": "transcript_artifact",
      "path": "artifacts/transcript-artifact.v1.json",
      "version": 1
    },
    {
      "kind": "candidate_artifact",
      "path": "artifacts/candidate-artifact.v1.json",
      "version": 1
    }
  ],
  "options": {}
}
```

Run it with:

```bash
vidmyo-repurpose rank --request /path/to/rank-request.json
```

Ranking reuses the candidate artifact's explicit provider and model by default;
`options.model` may supply another explicit validated model. The same strict,
non-streaming structured-output boundary, temperature zero, bounded retries,
secret redaction, and no-fallback policy apply. Tests inject this boundary and
never make a paid or network request.

The transcript-only `clip_potential` score is a weighted explanation, not a
prediction of virality, views, or engagement. Its fixed version-1 weights are
20% hook strength, 20% standalone coherence, 15% information value/novelty,
15% narrative arc/payoff, 15% context independence, 10% duration fitness, and
5% transcript-evidence quality. The first five components require a reason and
exact in-candidate word evidence. Duration fitness is 100 from 30–90 seconds
and declines linearly to 60 at 20 and 120 seconds. Evidence quality is mean
available word confidence; absent confidence produces a neutral 50.

Standalone coherence or context independence below 40 excludes a candidate
from the advisory shortlist without deleting it. Temporal duplicates use IoU
`>= 0.70` or containment `>= 0.85`. Semantic duplicates require the same
normalized topic and token-set Jaccard claim similarity `>= 0.80`. Transitive
groups retain every member; the highest-potential member (candidate ID on ties)
is the stable leader.

The first shortlist item is the strongest eligible group leader. Later items
apply a 12-point repeated-topic penalty and an 8-point nearby-time penalty;
nearby means within the greater of 180 seconds or 5% of source duration. The
shortlist stays shorter when unique eligible candidates run out. It is advisory
only: the version-1 ranking artifact never approves, rejects, selects for
rendering, repairs boundaries, or creates media.

Validated scores are atomically cached per candidate window. Exact final
matches are no-call, no-rewrite cache hits; interrupted retries reuse completed
window calls. Candidate content, transcript/candidate cache identity,
provider/model, prompt/schema/scoring/dedupe versions, weights, thresholds, or
requested shortlist count all participate in cache identity. Failures and
cancellation preserve completed inputs, valid caches, and any earlier ranking
artifact.

## Boundary repair and local preview extraction

After ranking completes, submit a `repair_boundaries` request naming the
current ingest, transcript, and ranking artifacts:

```bash
vidmyo-repurpose repair-boundaries --request /path/to/boundary-request.json
```

By default, Vidmyo repairs and extracts only the advisory shortlist, in its
existing order. Set `options.candidate_ids` to extract any explicit set of
retained candidates on demand. Optional `boundary_overrides` select exact
first and last transcript word IDs; otherwise the engine preserves the
candidate's word-safe span and snaps outward to nearby detected silence when
that remains within 20–120 seconds.

The worker writes `artifacts/boundary-artifact.v1.json` atomically and creates
source-aspect H.264/AAC preview clips under `artifacts/preview-clips/`. It
validates duration, audio, video, and fingerprints before marking a preview
complete. Exact retries are no-rewrite cache hits; changed target requests
reuse already validated clips. Cancellation stops at a safe candidate boundary
and preserves completed previews for retry.

This stage is entirely local: it makes no provider or network call and never
uploads or modifies the source. It does not approve candidates, change ranking,
reframe, caption, translate, produce final delivery media, or publish anything.

## Single-speaker vertical reframing

After boundary repair, submit a `reframe` request naming the current completed
`boundary_artifact`:

```bash
vidmyo-repurpose reframe --request /path/to/reframe-request.json
```

The default target set is the completed Issue 6 recommended previews.
`options.candidate_ids` can instead name any explicit completed retained
preview. Vidmyo samples each local preview every 0.5 seconds with the bundled
YuNet CPU face detector. Exactly one stable, sufficiently confident face uses
a smoothed 9:16 crop. Missing, multiple, low-confidence, insufficiently
covered, or unsafe faces use the safety layout: the complete uncropped source
frame centered over a blurred full-canvas copy.

Outputs are local 1080×1920 H.264/AAC previews under
`artifacts/reframed-previews/`. The versioned
`artifacts/reframe-artifact.v1.json` records detections, confidence, crop
segments, fallback reasons, settings, cache identity, and output state.
Outputs are atomically written and validated with ffprobe. Exact retries do not
rewrite validated media, while cancellation resumes after the last completed
candidate.

YuNet is bundled with its license and checksum, so reframing performs no model
download, upload, account login, provider call, or paid API request. It does
not recognize identities, approve candidates, add captions, create final
masters, or publish media.

## Stable two-speaker split layouts

After single-speaker reframing, submit `reframe-two` with exactly the current
completed `reframe_artifact` v1 and matching `boundary_artifact` v1:

```bash
vidmyo-repurpose reframe-two --request /path/to/reframe-two-request.json
```

Single-speaker tracked outputs are reused byte-for-byte. A candidate that used
the v1 `multiple_faces` fallback is eligible for a local two-speaker layout when
exactly two confident faces remain visible and spatially unambiguous for at
least 80% of samples. The source-left person is assigned to the upper 1080×960
panel and source-right person to the lower panel. Each panel is independently
smoothed and protected by the same safe-crop rules.

Missing or extra faces, low paired coverage, ambiguous crossing, or an unsafe
panel crop reuses the validated v1 blurred full-frame fallback. Vidmyo does not
guess identities or reconstruct a second person who is not visible in the
source frame.

New split outputs are atomically rendered as local 1080×1920 H.264/AAC previews
under `artifacts/reframed-previews-v2/`. The unified
`artifacts/reframe-artifact.v2.json` records v1 provenance, face assignments,
panel crops, fallback reasons, cache identity, and output state. Exact retries
reuse validated work, and cancellation resumes at the first incomplete
candidate.

This step uses only the face evidence produced by the bundled YuNet detector
and local FFmpeg. It performs no diarization, active-speaker switching, face
recognition, network request, model download, account login, upload, or paid
service call.

## Captioned masters and platform exports

After reframe v2 completes and the project manifest contains at least one
manually approved candidate, submit `render` with the current transcript v1,
boundary v1, reframe v1, and reframe v2 descriptors:

```bash
vidmyo-repurpose render --request /path/to/render-request.json
```

The default target set is the intersection of the completed reframe-v2 request
and candidates explicitly approved and selected in `repurpose.json`. An
explicit `options.candidate_ids` list may render another completed retained
candidate, but it must still be manually approved. Pending and rejected
candidates never render. `options.caption_style` accepts `clean` or `bold`,
`options.captions_enabled` may disable captions, and `options.platforms`
accepts `youtube_shorts`, `tiktok`, and `instagram_reels`.

Caption cues are reconstructed from authoritative transcript word IDs within
the repaired boundary. Words are grouped deterministically into short phrase
cues. OpenCV renders each complete phrase to a project-owned transparent PNG
after measuring its visible pixels, then adds equal left/right backing padding.
FFmpeg composites those local overlays at cue time without depending on the
optional `ass`, `subtitles`, or `drawtext` filters. No usable cue produces a
valid uncaptioned master with a recorded reason.

Outputs are local and deterministic:

- `artifacts/captions/<candidate>.<style>.json`
- `artifacts/captions/<candidate>.<style>/<cue>.png`
- `artifacts/rendered-masters/<candidate>.<style>.master.mp4`
- `artifacts/platform-exports/<candidate>.<style>.<platform>.mp4`
- `artifacts/render-artifact.v1.json`

Every master and export is atomically written and validated with FFprobe for
H.264 video, AAC audio, 1080×1920 dimensions, duration, and fingerprint. Exact
retries do not rewrite files. Cancellation checkpoints the current master and
completed preset prefix, then resumes at the first missing export. Changed
approvals, transcript/boundary/reframe identity, caption style, cue contract,
preset, encoder contract, or output bytes invalidate affected work.

## Desktop worker bridge

The active Electron/Next.js app runs these commands through the pure Node
`@vidmyo/core` Repurpose runner. Each desktop stage creates one durable
`type: repurpose` record in `~/.vidmyo/jobs` and writes its exact version-1
request under `<project>/.vidmyo/requests/`. Worker stdout is parsed only as
ordered JSONL; shell execution and arbitrary IPC/filesystem access are not
exposed to the renderer.

The desktop `reframe` stage runs the single-speaker and two-speaker workers
in order under one parent job, checkpointing each substep. A desktop restart
does not mark a persisted running job complete: the user must explicitly
resume it, at which point the same job ID and Python artifact caches are reused.
Cancellation is scoped to the child owned by that job and leaves the manifest
stage retryable. Candidate and ranking reconciliation preserve manual approval
and selection; only the user-facing decision methods can change them.

The preload surface is `window.repurpose`. It provides project/source pickers,
create/open, stage run/resume/cancel, job inspection, manual candidate decisions,
project-owned JSON reads/reveal, and read-only readiness. Readiness checks the
configured Python executable, local package import, FFmpeg, FFprobe, and model
cache without downloading a model. The renderer may atomically configure only
an absolute model-cache path; the Python executable and trusted engine location
come from the app/process configuration and cannot be turned into generic
process execution over IPC. Provider keys remain in the existing OS keychain
and never enter project request or job records.

Rendering is local and private. It does not translate, upload, publish,
schedule, authenticate to social platforms, call a provider, download a model,
or modify source and earlier pipeline media.
