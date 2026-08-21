# Vidmyo MCP

Vidmyo exposes the same tool surface over two local transports:

- **stdio** works while Vidmyo is closed and reads provider keys only from the spawned process environment.
- **hosted HTTP** runs inside the Electron app at a loopback-only URL and can use keys already stored by Vidmyo. Its generated bearer token is required on every request.

Both transports register tools from `mcp/lib/tools.js`. Repurpose operations use the same `@vidmyo/core` project, job, and Python-worker contracts as the desktop studio.

## Requirements

- Node.js 18 or newer and `npm ci` in this directory.
- Python 3 with the Repurpose package dependencies for Repurpose tools.
- `ffmpeg` and `ffprobe` on `PATH` for local media stages.
- The separate Video Delta service for the legacy Video Delta tools.
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

## Other Vidmyo tools

- Video Delta: `list_capabilities`, `create_video`, `create_film`, `reframe`, `insert_element`, `get_job`, `publish_video`, `list_publish_status`.
- Story: `story_sheet_rows`, `story_create`, `story_open`, `story_set_script`, `story_run_stage`, `story_accept_artifact`, `story_approve_scene`, `story_generate_scene`.
- Cloud generation: `generate_image`, `generate_video`, `get_generation_job`.

Generation and publishing tools may use external services or spend provider credits. Read their tool descriptions and do not retry paid submissions blindly.

## Verification

```bash
cd "/absolute/path/to/Vidmyo/mcp"
npm test
```

`smoke.mjs` exercises a real Video Delta render and therefore requires that separate engine. Repurpose protocol tests are offline and use disposable local fixtures; they do not call providers, download models, or read user media.
