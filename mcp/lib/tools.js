import {createVfxMcpService} from './vfxService.js';
// Vidmyo MCP tool surface — shared by BOTH hosts:
//   - mcp/server.js        stdio, standalone (works with Vidmyo closed; keys from env)
//   - electron/lib/mcpHost.js  loopback HTTP, hosted inside Vidmyo (keys from the OS
//                              keychain, image source from Settings → Story)
//
// Everything a tool needs from its host arrives via `ctx` — never read straight from
// the environment here, or the hosted server would silently miss the keychain.

import { z } from 'zod';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { videoDelta } from './videoDelta.js';
import {
  Project, DoodlePipeline, stageVoiceover, stageBeats, stageAssemble, stageFinalize,
  stageStatus, validateScript, getStyle, readSheetValues, trackerRows, sheetIdFromInput,
  getImageSource, resolveImageModel, JobStore, runJob,
  GENERATION_SOURCES, getGenerationSource, resolveGenerationModel,
  buildGenerationParams, makeGenerationAdapter,
  vidmyoHome,
} from '../../packages/core/index.js';
import { createRepurposeMcpService } from './repurposeService.js';
import { createCleanerMcpService } from './cleanerService.js';
import { createTranslateMcpService } from './translateService.js';
import { createGenerationConsent } from './generationConsent.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
export function publicMcpError(error) {
  const raw = String(error?.message || error || 'Operation failed');
  if (/not approved|human confirmation|human review|awaiting.*review/i.test(raw)) return 'Paid generation was not approved. Review the request in Vidmyo; no provider request was submitted.';
  if (/cancel/i.test(raw)) return 'Operation cancelled.';
  if (/not found|missing|does not exist|no such file/i.test(raw)) return 'Required project input was not found.';
  if (/permission|access denied|EACCES/i.test(raw)) return 'Vidmyo cannot access the requested project resource.';
  if (/invalid|must |expected|requires?/i.test(raw)) return 'The request did not match the tool contract.';
  if (/auth|sign[ -]?in|credential|api.?key|token/i.test(raw)) return 'The configured provider is not connected.';
  if (/quota|rate.?limit|credits?|billing/i.test(raw)) return 'The provider usage limit prevented this operation.';
  return 'The operation failed. Review the project in Vidmyo and retry.';
}
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: publicMcpError(err) }] });
// Parked by launch-scope decision. No host/env/agent override in this release.
const VIDEO_DELTA_ENABLED = false;

const mcpResult = value => ({
  structuredContent: value,
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const mcpFailure = error => {
  const value = { contract_version: 1, error: publicMcpError(error) };
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
};

const absolutePathSchema = z.string().min(1).max(4096).refine(value => path.isAbsolute(value), {
  message: 'must be an absolute local path',
});
const projectPathSchema = absolutePathSchema.describe('Absolute path to a local Repurpose project directory');
const candidateIdSchema = z.string().regex(/^clip_\d{3,}$/).max(64);
const platformsSchema = z.array(z.enum(['youtube_shorts', 'tiktok', 'instagram_reels']))
  .min(1).max(3).refine(items => new Set(items).size === items.length, 'platforms must not contain duplicates');
const analysisOptionsSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  language: z.string().min(2).max(35).optional(),
  device: z.enum(['auto', 'cpu', 'cuda']).optional(),
  compute_type: z.enum(['auto', 'int8', 'int8_float16', 'float16', 'float32']).optional(),
  model_cache: absolutePathSchema.optional(),
  provider: z.enum(['openrouter']).optional(),
  candidate_ids: z.array(candidateIdSchema).min(1).max(100).optional(),
}).strict();

export function registerRepurposeTools(server, service) {
  const call = handler => async args => {
    try { return mcpResult(await handler(args)); } catch (error) { return mcpFailure(error); }
  };

  server.registerTool('repurpose_create', {
    title: 'Create Repurpose Project',
    description: 'Create a local-file Repurpose project in an explicit empty directory. This only writes the project contract; it does not analyze media, call a provider, download a model, approve clips, render, or publish.',
    inputSchema: z.object({
      project_dir: absolutePathSchema.describe('Absolute empty destination directory; existing files are never overwritten'),
      source_path: absolutePathSchema.describe('Absolute path to an existing local video file'),
      requested_clip_count: z.number().int().min(1).max(20).default(5),
      content_type: z.enum(['auto', 'podcast', 'interview', 'lecture', 'webinar', 'commentary', 'talking_head', 'general_speech']).default('auto'),
      target_platforms: platformsSchema.default(['youtube_shorts', 'tiktok', 'instagram_reels']),
      captions_enabled: z.boolean().default(true),
      caption_style: z.enum(['clean', 'bold']).default('clean'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.create({
    projectDir: args.project_dir,
    sourcePath: args.source_path,
    requestedClipCount: args.requested_clip_count,
    contentType: args.content_type,
    targetPlatforms: args.target_platforms,
    renderDefaults: { captions: { enabled: args.captions_enabled, style: args.caption_style } },
  })));

  server.registerTool('repurpose_analyze', {
    title: 'Start or Resume Repurpose Analysis',
    description: 'Start the next durable analysis stage (ingest through reframe) and return immediately with a job id. A supplied stage must be exactly next. Existing completed stages are preserved, persisted running work resumes, and candidates are never approved or selected automatically. Poll get_repurpose_job.',
    inputSchema: z.object({
      project_dir: projectPathSchema,
      stage: z.enum(['ingest', 'transcribe', 'generate_candidates', 'rank', 'repair_boundaries', 'reframe']).optional(),
      stage_options: analysisOptionsSchema.default({}),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, call(args => service.analyze({ projectDir: args.project_dir, stage: args.stage, options: args.stage_options })));

  server.registerTool('repurpose_get', {
    title: 'Get Repurpose Project',
    description: 'Read a bounded Repurpose manifest/stage summary and its recent durable jobs. This does not read arbitrary project files or embed media.',
    inputSchema: z.object({ project_dir: projectPathSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.get({ projectDir: args.project_dir })));

  server.registerTool('repurpose_list_candidates', {
    title: 'List Repurpose Candidates',
    description: 'Read bounded candidate evidence, ranking, manual decision/selection, and project-relative preview/export references. No media bytes or arbitrary file content is returned.',
    inputSchema: z.object({
      project_dir: projectPathSchema,
      decision: z.enum(['pending', 'approved', 'rejected']).optional(),
      selected: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.listCandidates({
    projectDir: args.project_dir,
    decision: args.decision || null,
    selected: args.selected ?? null,
    limit: args.limit,
  })));

  server.registerTool('repurpose_set_candidate_decision', {
    title: 'Review One Repurpose Candidate',
    description: 'Perform one explicit review action. Approve/reject/reset changes the human decision; select/unselect is separate, and select requires prior approval. Review is locked while project work is queued or running. This never publishes.',
    inputSchema: z.object({
      project_dir: projectPathSchema,
      candidate_id: candidateIdSchema,
      action: z.enum(['approve', 'reject', 'reset', 'select', 'unselect']),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.setCandidateDecision({
    projectDir: args.project_dir,
    candidateId: args.candidate_id,
    action: args.action,
  })));

  server.registerTool('repurpose_render', {
    title: 'Render Approved Repurpose Clips',
    description: 'Start or resume the durable local render for manually approved and selected candidates, then return immediately with a job id. Produces local files only: it never uploads, schedules, authenticates, or publishes. Poll get_repurpose_job.',
    inputSchema: z.object({
      project_dir: projectPathSchema,
      candidate_ids: z.array(candidateIdSchema).min(1).max(100).optional()
        .describe('Optional exact approved selection; omit to use the project selection'),
      captions_enabled: z.boolean().default(true),
      caption_style: z.enum(['clean', 'bold']).default('clean'),
      platforms: platformsSchema.optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.render({
    projectDir: args.project_dir,
    candidateIds: args.candidate_ids || null,
    captionsEnabled: args.captions_enabled,
    captionStyle: args.caption_style,
    platforms: args.platforms || null,
  })));

  server.registerTool('get_repurpose_job', {
    title: 'Get Repurpose Job',
    description: 'Poll one durable Repurpose job. Returns bounded public progress, project-relative artifacts, error, and recovery guidance; it rejects all other Vidmyo job types.',
    inputSchema: z.object({ job_id: z.string().regex(/^job_[\w-]+$/).max(100) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.getJob({ jobId: args.job_id })));
}

export function registerVfxTools(server, service = createVfxMcpService()) {
  const call = handler => async args => {try {return mcpResult(await handler(args));} catch(error) {return mcpFailure(error);}};
  server.registerTool('vfx_open', {
    title: 'Open VFX Project',
    description: 'Inspect an existing desktop VFX project, local transcript, reviewed shots, director/motion rules and theme board paths. Create and prepare the project in the VFX tab first. No provider call.',
    inputSchema: z.object({project_dir: absolutePathSchema}).strict(),
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, call(args => service.open(args.project_dir)));
  server.registerTool('vfx_submit_plan', {
    title: 'Submit VFX Beat Plan',
    description: 'Submit a complete Perfect VFX renderer spec to an existing prepared project. Validates anchors, timing, cut boundaries and shot/layout gating. Invalidates earlier output. Human reviews and renders in the VFX tab; this never renders or approves its own plan.',
    inputSchema: z.object({project_dir: absolutePathSchema,spec: z.record(z.string(),z.unknown())}).strict(),
    annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  }, call(args => service.submitPlan(args.project_dir,args.spec)));
}

export function registerCleanerTools(server, service) {
  const call = handler => async args => {
    try { return mcpResult(await handler(args)); } catch (error) { return mcpFailure(error); }
  };
  const cleanerProject = absolutePathSchema.describe('Absolute path to a local Cleaner project');
  const cutSchema = z.object({
    segment_id: z.string().regex(/^segment_\d{6}$/),
    category: z.enum(['retake', 'false_start', 'direction', 'non_speech']),
    reason: z.string().min(1).max(240),
  }).strict();

  server.registerTool('cleaner_create', {
    title: 'Create Cleaner Project',
    description: 'Create a review-first talking-head cleanup project. This records the edit brief but makes no AI call and never publishes.',
    inputSchema: z.object({
      project_dir: cleanerProject, source_path: absolutePathSchema,
      script_mode: z.enum(['exact', 'rough', 'freestyle']),
      script_text: z.string().max(200000).optional(), include_mp4: z.boolean().default(true),
      save_mode: z.enum(['downloads', 'source', 'custom']).default('custom'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.create({ projectDir: args.project_dir, sourcePath: args.source_path, scriptMode: args.script_mode, scriptText: args.script_text, includeMp4: args.include_mp4, saveMode: args.save_mode })));

  server.registerTool('cleaner_prepare', {
    title: 'Prepare Cleaner Transcript',
    description: 'Run or resume the next local inspect/transcribe stage. Poll the returned Repurpose job, then call again until ready_for_decisions. No editorial AI call is made.',
    inputSchema: z.object({ project_dir: cleanerProject, transcription: z.object({ model: z.string().optional(), language: z.string().optional(), model_cache: absolutePathSchema.optional() }).strict().default({}) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.prepare({ projectDir: args.project_dir, stageOptions: args.transcription })));

  server.registerTool('cleaner_get', {
    title: 'Get Cleaner Project', description: 'Read bounded Cleaner stages and plan summary.',
    inputSchema: z.object({ project_dir: cleanerProject }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.get({ projectDir: args.project_dir })));

  server.registerTool('cleaner_get_transcript', {
    title: 'Read Cleaner Transcript',
    description: 'Read a bounded page of transcript segments so the current agent can conservatively identify retakes and false starts without receiving any hidden skill file.',
    inputSchema: z.object({ project_dir: cleanerProject, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(120) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.getTranscript({ projectDir: args.project_dir, offset: args.offset, limit: args.limit })));

  server.registerTool('cleaner_submit_plan', {
    title: 'Submit Cleaner Cut Plan',
    description: 'Submit only clear transcript segment removals. Omitted segments are kept. The user still reviews every decision before export.',
    inputSchema: z.object({ project_dir: cleanerProject, cuts: z.array(cutSchema).max(5000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.submitPlan({ projectDir: args.project_dir, cuts: args.cuts })));

  server.registerTool('cleaner_set_decision', {
    title: 'Override Cleaner Decision', description: 'Keep or cut one transcript segment in the reversible review plan.',
    inputSchema: z.object({ project_dir: cleanerProject, segment_id: z.string().regex(/^segment_\d{6}$/), decision: z.enum(['keep', 'cut']) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.setDecision({ projectDir: args.project_dir, segmentId: args.segment_id, decision: args.decision })));

  server.registerTool('cleaner_render', {
    title: 'Render Cleaner Project', description: 'Render the approved cleanup plan to one local MP4. Never uploads or publishes.',
    inputSchema: z.object({ project_dir: cleanerProject }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.render({ projectDir: args.project_dir })));
}

// ── Story Studio tools (v0.2) ───────────────────────────────────────────────
// The agent-facing pipeline: agents do the thinking (script per the channel
// rules, fact-checking, prompts); these tools run the deterministic stages.
// The sheet is a read-only queue; project.json is the source of truth.

// ../.. — this file sits in mcp/lib/, so the repo root is two levels up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');

function makePipeline() {
  const candidates = [
    process.env.VIDMYO_VENV_PYTHON,
    path.join(REPO, 'packages', 'core', 'pipelines', 'doodle', 'scripts', '.venv', 'bin', 'python'),
    '/Volumes/My Lexar/AI Projects/Faceless YT 1/pipeline/.venv/bin/python',
  ].filter(Boolean);
  const venvPython = candidates.find((p) => fs.existsSync(p));
  if (!venvPython) {
    throw new Error(`No pipeline venv found. Set VIDMYO_VENV_PYTHON or run pipelines/doodle/scripts/setup_env.sh. Tried: ${candidates.join(' | ')}`);
  }
  return new DoodlePipeline({ venvPython });
}

export function storySummary(project) {
  const m = project.manifest;
  const brief = m.brief && typeof m.brief === 'object' ? m.brief : {};
  return {
    dir: project.dir,
    brief: {
      topic: typeof brief.topic === 'string' ? brief.topic.slice(0, 300) : '',
      hook: typeof brief.hook === 'string' ? brief.hook.slice(0, 500) : '',
      angle: typeof brief.angle === 'string' ? brief.angle.slice(0, 500) : '',
    },
    style: typeof m.style === 'string' ? m.style.slice(0, 80) : null,
    script_words: m.script ? m.script.trim().split(/\s+/).length : 0,
    voiceover: m.voiceover.source ? { source: m.voiceover.source, artifact: m.voiceover.artifact } : null,
    scenes: m.scenes.map((s) => ({
      id: s.id, beat: s.beat,
      artifact: s.image.artifact, approved: s.image.approved,
      narration_span: s.narrationSpan,
    })),
    renders: m.renders,
    status: stageStatus(project),
  };
}

/**
 * Register every Vidmyo tool onto an McpServer.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {(providerId: string) => string} ctx.secrets  provider id -> API key ('' if none)
 * @param {() => {imageSource: string, imageModel: string|null}} ctx.imageConfig
 * @param {string} [ctx.keyHint]  where a missing key should be added, in host terms
 */
const translateInputSchema = z.union([
  z.string().min(1).max(4096).describe('An http(s) video URL, or an absolute path to a local video file'),
  z.object({
    type: z.enum(['url', 'file', 'media']).optional(),
    uri: z.string().min(1).max(4096),
  }).strict(),
]).describe('Video to translate: a URL, a local file path, or an existing Vidmyo media reference');

export function registerTranslateTools(server, service) {
  const call = handler => async args => {
    try { return mcpResult(await handler(args)); } catch (error) { return mcpFailure(error); }
  };

  server.registerTool('translate_capabilities', {
    title: 'Translate Video Capabilities',
    description: 'Read which source/target language pairs, voice-clone languages and optional stages (source separation, subtitle burn-in, lip sync) the local Translate Video stack currently supports. Call this before translating so you can explain any fallback. Local only; no provider call.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(() => service.capabilities()));

  server.registerTool('translate_video', {
    title: 'Translate Video',
    description: 'Translate/dub one video into another language locally (transcription, translation, translated voice, background handling, subtitles, render). Returns a job_id immediately; a full dub takes minutes, so poll translate_get_job and do NOT submit the same video twice. Heavy work runs one job at a time. Accepts a supported http(s) video URL or an absolute local video path; private/link-local URLs and non-video files are rejected. Speech, transcripts and voices stay on this machine. Voice cloning requires a voice profile the user created with the speaker\'s permission; when cloning is unavailable the job continues with the standard local voice and reports a warning.',
    inputSchema: z.object({
      input: translateInputSchema,
      target_language: z.string().min(2).max(35).describe('Target language code, e.g. "pl", "es", "en"'),
      source_language: z.string().min(2).max(35).default('auto').describe('"auto" to detect, or an ISO code'),
      translate_audio: z.boolean().default(true).describe('Produce translated speech; false = subtitles only'),
      clone_voice: z.boolean().default(true).describe('Preserve the original speaker voice where a voice profile is available'),
      voice_id: z.string().min(1).max(512).optional().describe('Local voice profile id to clone (required for real cloning)'),
      preserve_background: z.boolean().default(true),
      background_mode: z.enum(['duck', 'keep', 'replace', 'separate']).default('duck')
        .describe('duck = lower the original under the dub (keeps music); separate = remove the original voice with local Demucs; keep = original at full level; replace = dub only'),
      subtitles: z.boolean().default(true).describe('Write a translated SRT artifact'),
      burn_subtitles: z.boolean().default(false).describe('Burn subtitles into the video (needs libass)'),
      lip_sync: z.boolean().default(false).describe('Experimental; skipped with a warning when no backend is configured'),
      quality: z.enum(['fast', 'quality']).default('quality').describe('Transcription/translation fidelity vs speed'),
      translation_model: z.string().min(1).max(200).optional().describe('Override the local translation model'),
      transcription_model: z.string().min(1).max(200).optional().describe('Override the local Whisper model'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, call(args => service.start({
    input: args.input,
    options: {
      source_language: args.source_language,
      target_language: args.target_language,
      translate_audio: args.translate_audio,
      clone_voice: args.clone_voice,
      voice_id: args.voice_id || null,
      preserve_background: args.preserve_background,
      background_mode: args.background_mode,
      subtitles: args.subtitles,
      burn_subtitles: args.burn_subtitles,
      lip_sync: args.lip_sync,
      quality: args.quality,
      translation_model: args.translation_model || null,
      transcription_model: args.transcription_model || null,
    },
  })));

  server.registerTool('translate_get_job', {
    title: 'Get Translate Video Job',
    description: 'Poll one durable Translate Video job: state, current stage, per-stage checklist, language pair, progress, project-relative outputs, warnings, measured timings and failure reason. Distinct from get_repurpose_job and get_generation_job; it rejects other Vidmyo job types.',
    inputSchema: z.object({
      job_id: z.string().regex(/^job_[\w-]+$/).max(100),
      include_transcript: z.boolean().default(false).describe('Also return the translated line list (bounded)'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(async args => {
    const job = await service.get(args.job_id);
    if (!args.include_transcript) return job;
    try {
      return { ...job, transcript: service.readArtifact(args.job_id, 'artifacts/translation.json') };
    } catch { return job; }
  }));

  server.registerTool('translate_list_jobs', {
    title: 'List Translate Video Jobs',
    description: 'Read recent Translate Video history (newest first) with the language pair, state and progress of each job. Use one entry to decide what to poll or retry.',
    inputSchema: z.object({
      state: z.enum(['queued', 'running', 'done', 'error', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.list({ state: args.state || null, limit: args.limit })));

  server.registerTool('translate_cancel_job', {
    title: 'Cancel Translate Video Job',
    description: 'Cancel a queued or running translate job. Completed stages and their artifacts stay on disk, so a later retry resumes instead of starting over. Never deletes media.',
    inputSchema: z.object({ job_id: z.string().regex(/^job_[\w-]+$/).max(100) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, call(args => service.cancel(args.job_id)));

  server.registerTool('translate_retry_job', {
    title: 'Retry Translate Video Job',
    description: 'Retry a failed or cancelled translate job. Returns a NEW job id over the same project: stages that already produced an artifact are not re-run (a late render or subtitle failure never repeats transcription or translation). Poll translate_get_job with the returned id.',
    inputSchema: z.object({ job_id: z.string().regex(/^job_[\w-]+$/).max(100) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, call(args => service.retry(args.job_id)));
}

export function registerTools(server, ctx = {}) {
  const secrets = ctx.secrets || (() => '');
  const imageConfig = ctx.imageConfig || (() => ({ imageSource: 'flow', imageModel: null }));
  const approveGeneration = createGenerationConsent(ctx.confirmGeneration);
  const keyHint = ctx.keyHint || 'the host that launched this MCP server';
  const repurposeService = ctx.repurposeService || createRepurposeMcpService({ secrets });
  const cleanerService = ctx.cleanerService || createCleanerMcpService({ repurposeService });
  const translateService = ctx.translateService || createTranslateMcpService({});

  registerRepurposeTools(server, repurposeService);
  registerCleanerTools(server, cleanerService);
  registerTranslateTools(server, translateService);
  registerVfxTools(server, ctx.vfxService);

  if (VIDEO_DELTA_ENABLED) {
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
    + 'photoreal generative motion (~7 min); motion="composite" = sprite-compositing tier '
    + '(~3-5 min — faster than LTX, but not instant; still renders a hero frame first). '
    + 'Returns a job_id — poll get_job until done.',
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
    'publish_video',
    'Social autopilot: post a finished clip to YouTube/TikTok/Instagram. Preferred route is '
    + 'the user\'s own n8n (a webhook URL — their n8n posts with their connected account, so '
    + 'it already knows which channel/account). Native fallback: YouTube via OAuth; TikTok/IG '
    + 'need approved dev apps. Set dry_run to validate WITHOUT posting. privacy defaults to '
    + '"private" so autopilot never publishes publicly by accident — set "public"/"unlisted" '
    + 'deliberately. Use list_publish_status first to see each platform\'s route + readiness.',
    {
      video: z.string().describe('absolute path to the finished MP4 (from get_job "out")'),
      platform: z.enum(['youtube', 'tiktok', 'instagram']).default('youtube'),
      caption: z.string().default('').describe('description / caption text'),
      title: z.string().optional(),
      tags: z.array(z.string()).optional(),
      privacy: z.enum(['private', 'unlisted', 'public']).default('private'),
      dry_run: z.boolean().default(false).describe('true = validate only, do not post'),
    },
    async (args) => {
      try { return ok(await videoDelta.publish(args)); } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'list_publish_status',
    'Which social platforms are wired up and ready to post (credentials present + API '
    + 'implemented). Call before publish_video to know what will actually go out.',
    {},
    async () => {
      try { return ok(await videoDelta.publishStatus()); } catch (e) { return fail(e); }
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
  }
  server.tool(
    'story_sheet_rows',
    'List the video briefs on the tracker sheet (read-only). Rows have 1-based sheet row '
    + 'numbers, status (e.g. "Planned"), video #, working title, hook, and topic/angle. '
    + 'Pick a Planned row and pass its row number to story_create.',
    { sheet: z.string().min(1).describe('explicit Google Sheet URL or id') },
    async ({ sheet }) => {
      try {
        const sheetId = sheetIdFromInput(sheet) || sheet;
        const data = await readSheetValues(sheetId, 'A1:E60');
        return ok({ sheetId, via: data.via, rows: trackerRows(data.values) });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_create',
    'Create a new story project in a directory (must not already contain one). Give either '
    + 'a topic, or a tracker sheet_row — then the brief (title/hook/angle) is pulled from the '
    + 'sheet. Next step: write the script per the channel rules and call story_set_script.',
    {
      dir: z.string().describe('absolute path for the project folder (created if missing)'),
      topic: z.string().optional(),
      sheet_row: z.number().int().optional().describe('1-based tracker row to take the brief from'),
      sheet: z.string().optional().describe('explicit Google Sheet URL/id; required with sheet_row'),
    },
    async ({ dir, topic, sheet_row, sheet }) => {
      try {
        let brief = { topic: topic || 'untitled' };
        if (sheet_row) {
          if (!sheet) throw new Error('sheet must be supplied with sheet_row');
          const sheetId = sheetIdFromInput(sheet) || sheet;
          const data = await readSheetValues(sheetId, `A${sheet_row}:E${sheet_row}`);
          const r = data.values?.[0];
          if (!r || !r[2]) throw new Error(`Sheet row ${sheet_row} has no Working Title`);
          brief = { topic: r[2], hook: r[3] || '', angle: r[4] || '', videoNum: r[1] || '', sheetRow: sheet_row, sheetId };
        }
        return ok(storySummary(Project.create(dir, { brief })));
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_open',
    'Open an existing story project and report its full state: brief, script length, scenes '
    + 'with per-scene artifact/approval, renders, and which stage is next.',
    { dir: z.string() },
    async ({ dir }) => {
      try { return ok(storySummary(Project.load(dir))); } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_set_script',
    'Save the narration script. Enforces the channel retention rules: the response includes '
    + 'the word-count check (target 1,400-1,900 words for a 5:00+ video). Clean the text for '
    + 'TTS first (numbers spelled out, no markdown).',
    { dir: z.string(), script: z.string() },
    async ({ dir, script }) => {
      try {
        const project = Project.load(dir);
        project.manifest.script = script;
        project.save();
        const check = validateScript(script, getStyle(project.manifest.style));
        return ok({ script_check: check, status: stageStatus(project) });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_run_stage',
    'Run a pipeline stage SYNCHRONOUSLY (local, free): "to-scenes" = Kokoro voiceover + '
    + 'whisper beat detection + prompt scaffolding in one go (recommended after the script; '
    + 'takes seconds to a few minutes). "assemble" needs every scene approved unless '
    + 'allow_missing (white placeholder frames). "finalize" = 4K upscale + -14 LUFS master.',
    {
      dir: z.string(),
      stage: z.enum(['to-scenes', 'voiceover', 'beats', 'assemble', 'finalize']),
      force: z.boolean().default(false).describe('override the short-script gate (tests only)'),
      allow_missing: z.boolean().default(false).describe('assemble with white frames for missing scenes'),
    },
    async ({ dir, stage, force, allow_missing }) => {
      try {
        const project = Project.load(dir);
        const pipeline = makePipeline();
        if (stage === 'to-scenes') {
          await stageVoiceover(project, pipeline, { force });
          await stageBeats(project, pipeline);
        } else if (stage === 'voiceover') {
          await stageVoiceover(project, pipeline, { force });
        } else if (stage === 'beats') {
          await stageBeats(project, pipeline);
        } else if (stage === 'assemble') {
          await stageAssemble(project, pipeline, { allowMissing: allow_missing });
        } else if (stage === 'finalize') {
          await stageFinalize(project, pipeline);
        }
        return ok(storySummary(Project.load(dir)));
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_accept_artifact',
    'Attach a generated image to a scene. The file MUST already exist on disk (never claim '
    + 'downloads you have not verified). Prefer saving directly as <dir>/images/<sceneId>.png. '
    + 'Set approved only after you have actually viewed the image and it matches the beat.',
    {
      dir: z.string(),
      scene_id: z.string().describe('explicit sNNN id — never a line number'),
      path: z.string().describe('absolute path to the image file'),
      approved: z.boolean().default(false),
    },
    async ({ dir, scene_id, path: artifactPath, approved }) => {
      try {
        const project = Project.load(dir);
        project.acceptSceneArtifact(scene_id, artifactPath, { approved });
        return ok({ scene: storySummary(project).scenes.find((s) => s.id === scene_id), status: stageStatus(project) });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_approve_scene',
    'Mark a scene image approved after visual review (it matches the beat text, the style '
    + 'spec, and any on-screen text is spelled correctly).',
    { dir: z.string(), scene_id: z.string() },
    async ({ dir, scene_id }) => {
      try {
        const project = Project.load(dir);
        project.approveScene(scene_id);
        return ok({ status: stageStatus(project), pending: project.pendingScenes().map((s) => s.id) });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'story_generate_scene',
    'Generate ONE scene image from its prompt, using the image source the host is configured '
    + 'for, and attach it to the scene. The image is NOT auto-approved: look at it, then call '
    + 'story_approve_scene. Errors when the source is Google Flow — Flow has no API, so '
    + 'generate there and attach with story_accept_artifact instead. Paid: each call spends '
    + 'the account\'s credits and requires human confirmation in the Vidmyo desktop host. Do not retry blindly.',
    {
      dir: z.string(),
      scene_id: z.string().describe('explicit sNNN id — never a line number'),
      model: z.string().optional().describe('override the configured model for this one scene'),
    },
    async ({ dir, scene_id, model }) => {
      try {
        const project = Project.load(dir);
        const scene = project.getScene(scene_id);
        if (!scene.prompt) {
          throw new Error(`${scene_id} has no image prompt yet — run story_run_stage {stage:"to-scenes"} first`);
        }

        const cfg = imageConfig();
        const source = getImageSource(cfg.imageSource);
        if (source.manual) {
          throw new Error(`The image source is "${source.name}", which has no API to call. `
            + 'Generate the image there and attach it with story_accept_artifact, or pick a '
            + 'cloud source in Vidmyo → Settings → Story.');
        }
        const key = secrets(source.provider);
        if (!key) throw new Error(`No ${source.name} key available — add it in ${keyHint}.`);

        const imageModel = resolveImageModel(source.id, model || cfg.imageModel);
        // The doodle style locks 16:9; each provider's dialect lives in core/generation.js.
        const params = buildGenerationParams(source.id, 'image', { prompt: scene.prompt, aspect: '16:9' });
        await approveGeneration({ kind:'image', provider:source.id, model:imageModel, params });
        const adapter = makeGenerationAdapter(source.id, { key, model: imageModel, kind: 'image' });

        const store = new JobStore();
        const job = store.create({
          type: 'image', provider: source.id, project: project.manifest.id, params,
        });
        const done = await runJob(store, job.id, adapter, {
          outDir: path.join(dir, 'images'),
          pollMs: adapter.pollMs || 1500,
        });
        if (done.state !== 'done') throw new Error(done.error || `job ended in state ${done.state}`);

        // Rename the job-named artifact to the scene id so assemble.py finds it.
        const produced = done.artifacts[0].path;
        const dest = path.join(dir, 'images', `${scene_id}${path.extname(produced) || '.png'}`);
        fs.renameSync(produced, dest);
        project.acceptSceneArtifact(scene_id, dest);
        return ok({
          scene: storySummary(project).scenes.find((s) => s.id === scene_id),
          generated_with: { source: source.id, model: imageModel },
          status: stageStatus(project),
        });
      } catch (e) { return fail(e); }
    },
  );

  // ── Generic cloud generation (v0.3) ───────────────────────────────────────
  // Provider-backed generate tools with no Story project required: "make me an
  // image/video of X". Cloud (the user's own fal/Agnes key) — the local free
  // path stays create_video/create_film (Video Delta).

  // Which source a generic call uses when the agent didn't say: the Settings →
  // Story source if it can generate AND has a key (Flow is a story-workflow
  // choice with no API — skip it here), else the first catalog source with a
  // key. An explicit `source` always wins; a missing key on an explicit source
  // is an error, never a silent fallback to a different provider's bill.
  const resolveGenerationRequest = (kind, requestedSource) => {
    if (requestedSource) {
      const s = getGenerationSource(requestedSource);
      if (!s) throw new Error(`unknown source "${requestedSource}" (have: ${GENERATION_SOURCES.map((x) => x.id).join(', ')})`);
      const key = secrets(s.provider);
      if (!key) throw new Error(`No ${s.name} key available — add it in ${keyHint}.`);
      return { source: s, key };
    }
    if (kind === 'image') {
      const cfg = getGenerationSource(imageConfig().imageSource);
      const key = cfg && secrets(cfg.provider);
      if (key) return { source: cfg, key };
    }
    for (const s of GENERATION_SOURCES) {
      const key = secrets(s.provider);
      if (key) return { source: s, key };
    }
    throw new Error(`No cloud ${kind} source has an API key — add a fal.ai or Agnes AI key in ${keyHint}.`);
  };

  const ARTIFACTS = path.join(vidmyoHome(), 'artifacts');

  const readImageAsDataUrl = (p) => {
    const ext = path.extname(p).slice(1).toLowerCase() || 'png';
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  };

  server.tool(
    'generate_image',
    'Generate ONE image from a text prompt via the user\'s cloud provider (fal.ai or Agnes '
    + 'AI, their stored key). BLOCKS until the image is ready (seconds) and returns the '
    + 'absolute file path. Paid per image — never retry blindly on a content/validation '
    + 'error. For Story scene images prefer story_generate_scene (it attaches the result '
    + 'to the project). Requires native human approval in the running Vidmyo desktop host.',
    {
      prompt: z.string().describe('what to draw'),
      source: z.enum(['fal', 'agnes']).optional().describe('omit = the user\'s configured/default source'),
      model: z.string().optional().describe('override the source\'s default model'),
      aspect: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).default('16:9'),
      out_dir: z.string().optional().describe('absolute directory for the file (default ~/.vidmyo/artifacts)'),
    },
    async ({ prompt, source: requestedSource, model, aspect, out_dir }) => {
      try {
        const { source, key } = resolveGenerationRequest('image', requestedSource);
        const resolvedModel = resolveGenerationModel(source.id, 'image', model);
        const params = buildGenerationParams(source.id, 'image', { prompt, aspect });
        await approveGeneration({ kind:'image', provider:source.id, model:resolvedModel, params });
        const adapter = makeGenerationAdapter(source.id, { key, model: resolvedModel, kind: 'image' });
        const store = new JobStore();
        const job = store.create({ type: 'image', provider: source.id, params });
        const done = await runJob(store, job.id, adapter, {
          outDir: out_dir || ARTIFACTS,
          pollMs: adapter.pollMs || 1500,
        });
        if (done.state !== 'done') throw new Error(done.error || `job ended in state ${done.state}`);
        return ok({ path: done.artifacts[0].path, job_id: job.id, source: source.id, model: resolvedModel });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'generate_video',
    'Start ONE cloud video generation from a text prompt — optionally animating an input '
    + 'image — via the user\'s provider (fal.ai or Agnes AI, their stored key). Returns a '
    + 'job_id IMMEDIATELY; renders take minutes, so poll get_generation_job. On Agnes\'s '
    + 'free plan status advances at most once per minute — poll patiently, and NEVER '
    + 're-submit because a poll looked slow (each submit is paid). This is the CLOUD path; '
    + 'local AI video synthesis is not available in this release. Requires native human approval in the running Vidmyo desktop host.',
    {
      prompt: z.string().describe('what happens in the clip'),
      source: z.enum(['fal', 'agnes']).optional().describe('omit = the default source with a key'),
      model: z.string().optional().describe('override the source\'s default model'),
      aspect: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
      duration_seconds: z.number().optional().describe('omit = provider default'),
      image_path: z.string().optional().describe('absolute path to an image to ANIMATE (image-to-video)'),
    },
    async ({ prompt, source: requestedSource, model, aspect, duration_seconds, image_path }) => {
      try {
        const { source, key } = resolveGenerationRequest('video', requestedSource);
        const hasImage = !!image_path;
        if (hasImage && !fs.existsSync(image_path)) throw new Error(`image_path not found: ${image_path}`);
        const resolvedModel = resolveGenerationModel(source.id, 'video', model, { hasImage });
        const params = buildGenerationParams(source.id, 'video', {
          prompt, aspect, durationSeconds: duration_seconds || null,
          image: hasImage ? readImageAsDataUrl(image_path) : null,
        });
        await approveGeneration({ kind:'video', provider:source.id, model:resolvedModel, params });
        const adapter = makeGenerationAdapter(source.id, { key, model: resolvedModel, kind: 'video' });
        const store = new JobStore();
        const job = store.create({ type: 'video', provider: source.id, params });
        // Fire-and-forget: the render outlives this request. runJob checkpoints every
        // transition into ~/.vidmyo/jobs on disk, which is what get_generation_job
        // reads — so polling works even from a different MCP request/process.
        runJob(store, job.id, adapter, {
          outDir: ARTIFACTS,
          pollMs: adapter.pollMs || 4000,
          maxPolls: Math.ceil(1600000 / (adapter.pollMs || 4000)),
        }).catch(() => { /* runJob records its own error state in the store */ });
        return ok({
          job_id: job.id, state: 'queued', source: source.id, model: resolvedModel,
          poll_with: 'get_generation_job',
          ...(source.id === 'agnes' ? { note: 'Agnes free plan: status advances at most once per minute — wait 60s+ between polls.' } : {}),
        });
      } catch (e) { return fail(e); }
    },
  );

  server.tool(
    'get_generation_job',
    'Poll a CLOUD generation started by generate_video (generate_image job ids work too). '
    + 'Distinct from get_job, which polls the local Video Delta engine. When state is '
    + '"done", artifact is the absolute path to the file on disk.',
    { job_id: z.string() },
    async ({ job_id }) => {
      try {
        const job = new JobStore().get(job_id);
        if (!job) throw new Error(`unknown generation job: ${job_id}`);
        return ok({
          job_id,
          state: job.state,
          provider: job.provider,
          artifact: job.artifacts?.[0]?.path || null,
          error: job.error || null,
          log_tail: (job.logs || []).slice(-3),
        });
      } catch (e) { return fail(e); }
    },
  );
}
