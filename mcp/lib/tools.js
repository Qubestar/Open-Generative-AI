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
} from '../../packages/core/index.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });

// ── Story Studio tools (v0.2) ───────────────────────────────────────────────
// The agent-facing pipeline: agents do the thinking (script per the channel
// rules, fact-checking, prompts); these tools run the deterministic stages.
// The sheet is a read-only queue; project.json is the source of truth.

const DEFAULT_SHEET_ID = '1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo';
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

function storySummary(project) {
  const m = project.manifest;
  return {
    dir: project.dir,
    brief: m.brief,
    style: m.style,
    script_words: m.script ? m.script.trim().split(/\s+/).length : 0,
    voiceover: m.voiceover.source ? { source: m.voiceover.source, artifact: m.voiceover.artifact } : null,
    scenes: m.scenes.map((s) => ({
      id: s.id, beat: s.beat, prompt: s.prompt,
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
export function registerTools(server, ctx = {}) {
  const secrets = ctx.secrets || (() => '');
  const imageConfig = ctx.imageConfig || (() => ({ imageSource: 'flow', imageModel: null }));
  const keyHint = ctx.keyHint || 'the host that launched this MCP server';

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
  server.tool(
    'story_sheet_rows',
    'List the video briefs on the tracker sheet (read-only). Rows have 1-based sheet row '
    + 'numbers, status (e.g. "Planned"), video #, working title, hook, and topic/angle. '
    + 'Pick a Planned row and pass its row number to story_create.',
    { sheet: z.string().optional().describe('sheet URL or id (default: the Doodle 1 tracker)') },
    async ({ sheet }) => {
      try {
        const sheetId = sheet ? (sheetIdFromInput(sheet) || sheet) : DEFAULT_SHEET_ID;
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
      sheet: z.string().optional().describe('sheet URL/id when using sheet_row (default: Doodle 1)'),
    },
    async ({ dir, topic, sheet_row, sheet }) => {
      try {
        let brief = { topic: topic || 'untitled' };
        if (sheet_row) {
          const sheetId = sheet ? (sheetIdFromInput(sheet) || sheet) : DEFAULT_SHEET_ID;
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
    + 'the account\'s credits, so do not retry blindly on a content/validation error.',
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

  const ARTIFACTS = path.join(os.homedir(), '.vidmyo', 'artifacts');

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
    + 'to the project).',
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
    + 'create_video/create_film run the free local Video Delta engine instead.',
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
