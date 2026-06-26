# Vidmyo MCP

Vidmyo's own MCP server — gives any agent (Claude Code, Codex, Gemini CLI, …) a unified
video-creation interface. **Milestone 1** exposes the local **Video Delta** engine (free,
runs on a 16 GB Mac). Cloud tools (muapi | FAL | … — user-selectable) come in Milestone 2.

## Prerequisites

1. **Node 18+** and `npm install` in this folder.
2. **Video Delta engine running** (it's a separate product; we never bundle it):
   ```bash
   cd "/Volumes/My Lexar/AI Projects/Video Delta"
   source .venv/bin/activate
   python -m videodelta.api          # serves on 127.0.0.1:7861
   ```
   Point elsewhere with `VIDEODELTA_URL` if needed.

## Connect an agent

```bash
# Claude Code
claude mcp add --transport stdio vidmyo -- node "/Volumes/My Lexar/AI Projects/Vidmyo/mcp/server.js"

# Codex (config) / other CLIs: register the same command as an stdio MCP server.
```

## Tools

| Tool | What it does |
|------|--------------|
| `list_capabilities` | Engines, motions, defaults, LTX shot-length guidance. Call first. |
| `create_video` | One clip from a prompt. `motion=ltx` (quality, ~7 min) or `composite` (fast preview). → `job_id` |
| `create_film` | Multi-shot finished film (one look, same subject, crossfades, optional title + TTS narration/captions). → `job_id` |
| `insert_element` | Goal A: add an element into existing footage (depth-aware). → `job_id` |
| `get_job` | Poll a `job_id`; when `done`, `out` is the finished MP4 path. |

Renders are minutes-long, so generation tools are **async**: they return a `job_id`
immediately; poll `get_job` until `status` is `done`, then read `out`.

## Roadmap

Milestone 2 adds cloud tools (`generate_image`, `image_to_video`, `upscale`, `reframe`)
behind a **selectable provider** (muapi | FAL | …) via Vidmyo's existing proxy, plus a
hostable variant of this same tool surface for the paid product.
