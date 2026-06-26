#!/usr/bin/env node
// Vidmyo MCP server (stdio) — Milestone 1: exposes the local Video Delta engine to any
// agent (Claude Code, Codex, ...). Tool surface modeled on Higgsfield's video MCP
// (create/animate + async job model). Cloud tools (muapi | FAL | ...) come in Milestone 2.
//
// Connect:  claude mcp add --transport stdio vidmyo -- node <abs path>/Vidmyo/mcp/server.js
// Requires the Video Delta engine running:  python -m videodelta.api  (see lib/videoDelta.js)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { videoDelta } from './lib/videoDelta.js';

const server = new McpServer({ name: 'vidmyo', version: '0.1.0' });

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });

server.tool(
  'list_capabilities',
  'What the local Video Delta engine can do (engines, motions, defaults, and shot-length '
  + 'guidance). Call this first to learn how to drive the other tools well.',
  {},
  async () => {
    try { return ok(await videoDelta.capabilities()); } catch (e) { return fail(e); }
  },
);

server.tool(
  'create_video',
  'Create ONE short video clip from a text prompt, locally. motion="ltx" (default) = '
  + 'photoreal generative motion (~7 min); motion="composite" = fast sprite preview '
  + '(seconds, good for smoke tests). Returns a job_id — poll get_job until done.',
  {
    prompt: z.string().describe('what happens in the clip, e.g. "a red fox trots through snow"'),
    motion: z.enum(['ltx', 'composite']).default('ltx'),
    duration: z.number().default(3.0).describe('seconds (keep LTX ~2-3s for best resolution)'),
    fps: z.number().default(24.0),
    size: z.number().int().default(512).describe('generation resolution before upscale'),
    upscale: z.number().int().default(2).describe('super-resolution factor (1 = off)'),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).default('16:9')
      .describe('output shape: 16:9 YouTube, 9:16 TikTok/Reels/Shorts, 1:1 / 4:5 Instagram'),
  },
  async (args) => {
    try { return ok(await videoDelta.createVideo(args)); } catch (e) { return fail(e); }
  },
);

server.tool(
  'create_film',
  'Create a finished multi-shot film from a one-line brief: storyboarded shots (one global '
  + 'look, same subject across cuts), blur-crossfades, optional title card and TTS narration '
  + 'with synced captions. Returns a job_id — poll get_job.',
  {
    brief: z.string().describe('the film in one line, e.g. "a red fox explores a frozen river"'),
    shots: z.number().int().default(3).describe('number of shots (more short shots > fewer long ones)'),
    duration: z.number().default(9.0).describe('total seconds across all shots'),
    motion: z.enum(['ltx', 'composite']).default('ltx'),
    fade: z.number().default(0.4).describe('crossfade seconds between shots (0 = hard cuts)'),
    title: z.string().optional().describe('title card text (omit for no finishing stage)'),
    subtitle: z.string().optional(),
    narrate: z.string().optional().describe('narration script -> TTS voice + synced captions'),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).default('16:9')
      .describe('output shape: 16:9 YouTube, 9:16 TikTok/Reels/Shorts, 1:1 / 4:5 Instagram'),
  },
  async (args) => {
    try { return ok(await videoDelta.createFilm(args)); } catch (e) { return fail(e); }
  },
);

server.tool(
  'reframe',
  'Reframe an existing video file to a social aspect ratio (crop-to-fill, keeps audio). '
  + 'Use to repurpose one clip for TikTok/Reels (9:16), Instagram (1:1, 4:5), or YouTube (16:9).',
  {
    video: z.string().describe('absolute path to the video to reframe'),
    aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).default('9:16'),
    mode: z.enum(['crop', 'pad']).default('crop').describe('crop = fill (no bars); pad = fit'),
  },
  async (args) => {
    try { return ok(await videoDelta.reframe(args)); } catch (e) { return fail(e); }
  },
);

server.tool(
  'insert_element',
  'Goal A: insert a generated or supplied element INTO an existing video so it lives in the '
  + 'scene (depth-aware: occlusion, ground placement, shadow). Returns a job_id — poll get_job.',
  {
    video: z.string().describe('absolute path to the input video'),
    prompt: z.string().describe('what to add, e.g. "a crow lands on the fence post"'),
    element: z.string().optional().describe('optional path to an element image (else generated)'),
  },
  async (args) => {
    try { return ok(await videoDelta.direct(args)); } catch (e) { return fail(e); }
  },
);

server.tool(
  'get_job',
  'Poll a video job by id. Returns status (queued|running|done|error); when done, the "out" '
  + 'field is the absolute path to the finished MP4 on disk.',
  { job_id: z.string() },
  async ({ job_id }) => {
    try { return ok(await videoDelta.job(job_id)); } catch (e) { return fail(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
