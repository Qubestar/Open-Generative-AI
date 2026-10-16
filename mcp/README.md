# Vidmyo MCP

Vidmyo exposes the same tool surface over two local transports:

- **stdio** works while Vidmyo is closed and reads provider keys only from the spawned process environment.
- **hosted HTTP** runs inside the Electron app at a loopback-only URL and can use keys already stored by Vidmyo. Its generated bearer token is required on every request.

Both transports register tools from `mcp/lib/tools.js`. Repurpose operations use the same `@vidmyo/core` project, job, and Python-worker contracts as the desktop studio.

## Requirements

- Node.js 18 or newer and `npm ci` in this directory.
- Python 3 with the Repurpose package dependencies for Repurpose tools.
- `ffmpeg` and `ffprobe` on `PATH` for local media stages.
- No Video Delta service is required. Its legacy tools are parked and not registered in this release.
- `OPENROUTER_API_KEY` only for Repurpose candidate generation/ranking. No key is needed to create or inspect a project.

Check Repurpose runtime and transcription-model readiness without downloading anything:

```bash
cd "/absolute/path/to/Vidmyo"
PYTHONPATH="packages/repurpose-engine/src" python3 -m vidmyo_repurpose.cli doctor
```

To inspect a pre-provisioned model cache, append `--model-cache "/absolute/path/to/models"`. Doctor is read-only; a missing model is reported, not downloaded.

## Connect over stdio

```bash
claude mcp add --transport stdio vidmyo -- node "/absolute/path/to/Vidmyo/mcp/server.js"
```

Codex and other MCP clients can register the same command and absolute server argument. Optional environment variables are `OPENROUTER_API_KEY`, `FAL_KEY`, `AGNES_API_KEY`, `VIDMYO_IMAGE_SOURCE`, `VIDMYO_IMAGE_MODEL`, and `VIDMYO_REPURPOSE_PYTHON`.

## Connect to Vidmyo's hosted MCP

Open Vidmyo and use **Agents → Connect Vidmyo MCP**. The app registers its current `http://127.0.0.1:<port>/mcp` endpoint and bearer token where the selected client supports authenticated HTTP MCP.

The host:

- binds only to `127.0.0.1`;
- validates the endpoint, method, `Host`, and any browser `Origin`;
- compares its bearer token in constant time;
- never returns provider credentials from a tool.

Vidmyo must stay open while this transport is in use. Reconnect from the Agents screen if the preferred port was occupied and the endpoint changed.

## Repurpose workflow

Repurpose accepts local files and absolute project paths only. Long stages return a durable `job_id` immediately. Poll `get_repurpose_job`; do not submit a duplicate because work looks slow.

1. Create a project in an explicit empty destination:

   ```json
   {
     "tool": "repurpose_create",
     "arguments": {
       "project_dir": "/Users/me/Videos/interview-clips",
       "source_path": "/Users/me/Videos/interview.mp4",
       "requested_clip_count": 5,
       "content_type": "interview",
       "target_platforms": ["youtube_shorts", "tiktok", "instagram_reels"]
     }
   }
   ```

2. Call `repurpose_analyze` without `stage` to start the exact next stage. Poll the returned job, then repeat until reframe completes. Supplying `stage` is optional and cannot skip or rerun dependencies.
3. Inspect evidence with `repurpose_list_candidates`.
4. Review explicitly. Approval and selection are separate calls:

   ```json
   { "project_dir": "/Users/me/Videos/interview-clips", "candidate_id": "clip_001", "action": "approve" }
   ```

   ```json
   { "project_dir": "/Users/me/Videos/interview-clips", "candidate_id": "clip_001", "action": "select" }
   ```

5. Call `repurpose_render`. It returns a job immediately and creates local exports only.

Candidate review is locked while a project job is queued/running. A persisted `running` job with no owned process is not assumed failed: call the corresponding analysis/render tool again to resume it. Completed prerequisites, reviewed candidates, and valid artifacts remain on disk after failures or cancellation.

Repurpose never approves, selects, uploads, schedules, authenticates, or publishes automatically. Its output references are project-relative. The older generic `publish_video` tool is a separate Video Delta capability and is not called by any Repurpose tool; publishing requires a distinct deliberate user instruction.

## Repurpose tools

| Tool | Behavior |
|---|---|
| `repurpose_create` | Create a local project contract in an empty directory; no analysis. |
| `repurpose_analyze` | Start/resume the next analysis stage and return a durable job id. |
| `repurpose_get` | Read bounded project stages, counts, outputs, and recent jobs. |
| `repurpose_list_candidates` | Read evidence, rank, decision, selection, and relative media references. |
| `repurpose_set_candidate_decision` | One explicit approve/reject/reset/select/unselect action. |
| `repurpose_render` | Start/resume local rendering for approved selections. |
| `get_repurpose_job` | Poll bounded Repurpose progress, artifacts, errors, and recovery guidance. |

Every Repurpose result includes `contract_version: 1` in both MCP text content and `structuredContent`.

## Cleaner workflow

Cleaner turns one raw talking-head recording into one reviewable long-form edit. Through MCP, the current agent makes the editorial judgment directly; Vidmyo does not launch another nested agent or reveal an installed skill.

1. `cleaner_create` records the script mode and delivery choices in an empty project folder.
2. Call `cleaner_prepare`, poll its returned `get_repurpose_job`, and repeat until it reports `ready_for_decisions`. Inspection and transcription stay local.
3. Page through `cleaner_get_transcript`. Follow the returned conservative editorial rules and collect only clear retakes, false starts, camera directions, or transcript noise.
4. Call `cleaner_submit_plan`; every omitted segment defaults to keep.
5. Review or change individual items with `cleaner_set_decision`.
6. Call `cleaner_render` to create one local MP4. It never uploads or publishes.

| Tool | Behavior |
|---|---|
| `cleaner_create` | Create a versioned Cleaner brief without an AI call. |
| `cleaner_prepare` | Start/resume local inspection and transcription. |
| `cleaner_get` | Read bounded stages and plan summary. |
| `cleaner_get_transcript` | Read bounded transcript evidence and editorial rules. |
| `cleaner_submit_plan` | Submit conservative current-agent cut decisions. |
| `cleaner_set_decision` | Reversibly keep or cut one segment. |
| `cleaner_render` | Render the approved local cleanup to one MP4. |

## Translate Video workflow

Translate Video dubs a video into another language locally. It is a first-class
desktop tab (`Translate`) over the **same** service, job store and project
manifest these MCP tools use, so a job started by an agent shows up in the tab's
history and can be retried there — and vice versa. Nothing is uploaded to an AI
service: transcription, translation, voice and mixing all run on this machine.

1. Call `translate_capabilities` first. It reports the supported source/target and
   voice-clone languages plus which optional stages exist here (source separation,
   subtitle burn-in, lip sync), so you can explain a fallback instead of guessing.
2. Call `translate_video`. It returns a `job_id` immediately:

   ```json
   {
     "tool": "translate_video",
     "arguments": {
       "input": "https://example.com/video.mp4",
       "target_language": "pl",
       "source_language": "auto",
       "clone_voice": true,
       "background_mode": "separate",
       "subtitles": true
     }
   }
   ```

   `input` accepts an http(s) URL, an absolute local video path, or
   `{"type": "file", "uri": "..."}`. A full dub takes minutes on a 16 GB Mac —
   **poll `translate_get_job`; never submit the same video twice.** Heavy work runs
   one job at a time, so a second submission queues.

3. `translate_get_job` returns state, the current stage, a per-stage checklist,
   progress, the detected source language, project-relative outputs, warnings and
   measured per-stage timings. `include_transcript: true` also returns the
   translated line list.
4. `translate_list_jobs` is the history; `translate_cancel_job` stops a job
   (finished stages and their artifacts stay on disk); `translate_retry_job`
   returns a **new** job over the same project and skips every stage whose artifact
   already exists, so a late render or subtitle failure never repeats transcription
   or translation.

| Tool | Behavior |
|---|---|
| `translate_capabilities` | Read language pairs, clone languages and available optional stages. No provider call. |
| `translate_video` | Start a local translate/dub job; returns a durable job id. |
| `translate_get_job` | Poll one translate job (bounded; other job types are rejected). |
| `translate_list_jobs` | Recent translate history, newest first. |
| `translate_cancel_job` | Cancel a queued/running job without deleting artifacts. |
| `translate_retry_job` | New job over the same project, resuming at the first unfinished stage. |

Rejected before any work starts: non-HTTP URLs, URLs with credentials, loopback /
private / link-local / CGNAT addresses, cloud metadata hostnames, and any public
hostname that resolves into those ranges. Voice cloning uses a profile the user
created locally and requires the speaker's permission; when cloning is unavailable
the job continues with the standard local voice and reports a warning rather than
silently switching to another provider.

## Other Vidmyo tools

- Parked, not registered: the legacy Video Delta generation, compositing, polling, reframing and publishing tools. Clipper's own local framing/export remain available.
- Story: `story_sheet_rows`, `story_create`, `story_open`, `story_set_script`, `story_run_stage`, `story_accept_artifact`, `story_approve_scene`, `story_generate_scene`.
- Cloud generation: `generate_image`, `generate_video`, `get_generation_job`.

Generation and publishing tools may use external services or spend provider credits. Read their tool descriptions and do not retry paid submissions blindly.

## Verification

```bash
cd "/absolute/path/to/Vidmyo/mcp"
npm test
```

`smoke.mjs` exercises a real Video Delta render and therefore requires that separate engine. Repurpose protocol tests are offline and use disposable local fixtures; they do not call providers, download models, or read user media.
# Paid generation approval

`generate_image`, `generate_video` and `story_generate_scene` require a separate native human confirmation for each fal/Agnes API request in the running Vidmyo desktop host. The dialog shows provider/model, prompt/settings and data-egress/billing warnings; Cancel is the default. Agents cannot self-approve with tool arguments, and concurrent requests cannot flood approval dialogs. A denied or unavailable confirmation submits no provider job.

Standalone stdio has no trusted desktop confirmation channel and rejects those paid tools even when environment keys are configured. Use the running app’s hosted MCP for paid Image/Video generation. Local tools and polling existing generation jobs remain available. Video Delta tools are parked and unregistered. Story MCP stages use local Kokoro; desktop ElevenLabs narration has its own native per-request approval.
