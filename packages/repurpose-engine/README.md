# Vidmyo Repurpose engine contracts

This package is the versioned contract boundary, local ingest worker, and
local transcription worker for Vidmyo Repurpose. It requires Python 3.10 or newer. Local ingest also
requires `ffprobe` from FFmpeg to be available on `PATH`; it does not download,
copy, rank, reframe, render, or upload source media.

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
