// Editor — contract, planner and runner tests.
//
// Every expensive engine (FFmpeg, ffprobe, faster-whisper, HyperFrames, the Python
// driver) is replaced with a deterministic fake, so this suite is offline, fast,
// and safe to run while the desktop app is in use. The real end-to-end render is
// a separate, explicit run (docs/editor-v1.md §9 step 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EDITOR_STAGES,
  EDITOR_STAGE_ARTIFACTS,
  EDITOR_QUALITIES,
  STAGE_DEPENDENCIES,
  EDITOR_JOB_TYPE,
  EditorProject,
  EditorService,
  EditorTemplateStore,
  editorJobSummary,
  normalizeEditorOptions,
  planStages,
} from '../src/editor.js';
import {
  EDITOR_DEVICES,
  EDITOR_TREATMENTS,
  EDITOR_V1_PROFILE,
  buildPlanDocument,
  createEditorEngines,
  mergeStyleProfile,
  planBeatBoundaries,
  validatePlanDocument,
} from '../src/editorEngines.js';
import { runEditorAnalysisJob, runEditorJob } from '../src/editorRunner.js';
import { JobStore } from '../src/jobs.js';

const tmpdir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFootage({ withImages = true } = {}) {
  const dir = tmpdir('vidmyo-editor-footage-');
  fs.writeFileSync(path.join(dir, 'take.mp4'), Buffer.alloc(4096, 3));
  if (withImages) {
    fs.mkdirSync(path.join(dir, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pictures', 'street.jpg'), Buffer.alloc(2048, 5));
    fs.writeFileSync(path.join(dir, 'pictures', 'harbour.png'), Buffer.alloc(2048, 6));
    fs.writeFileSync(path.join(dir, 'broll.mp4'), Buffer.alloc(8192, 7));
  }
  return dir;
}

function makeMusicBed() {
  const dir = tmpdir('vidmyo-editor-music-');
  const file = path.join(dir, 'bed.mp3');
  fs.writeFileSync(file, Buffer.alloc(1024, 9));
  return file;
}

/** A transcript shaped like `normalizeTranscript` output. */
function fixtureTranscript(seconds = 4) {
  const words = [];
  let t = 0.15;
  const lexicon = ['real', 'footage', 'from', 'the', 'harbour', 'where', 'everything', 'started'];
  let index = 0;
  while (t < seconds - 0.3) {
    const length = 0.24;
    words.push({ w: lexicon[index % lexicon.length], s: Math.round(t * 1000) / 1000, e: Math.round((t + length) * 1000) / 1000 });
    t += length + 0.06;
    index += 1;
  }
  return {
    model: 'small',
    language: 'en',
    duration: seconds,
    words,
    segments: [{ id: 0, text: words.map(word => word.w).join(' '), s: words[0]?.s || 0, e: words[words.length - 1]?.e || 0, words }],
  };
}

function writeArtifact(project, relative, body) {
  const file = project.artifactPath(relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

const STUB_PROBE = {
  duration: 4,
  fps: 30,
  width: 1920,
  height: 1080,
  resolution: { width: 1920, height: 1080 },
  hasVideo: true,
  hasAudio: true,
  take: { path: '/tmp/vidmyo-fake-take.mp4', name: 'take.mp4', duration: 4 },
  streams: [],
};

const STUB_ASSETS = {
  face: 'work/cam_raw.mp4',
  stills: [{ asset: 'assets/media/still_001.jpg', kind: 'image' }, { asset: 'assets/media/still_002.png', kind: 'image' }],
  clips: [{ asset: 'assets/media/clip_001.mp4', kind: 'video' }],
  examples: [],
  counts: { stills: 2, clips: 1, examples: 0 },
};

const STUB_PLAN = {
  version: 1,
  engine: 'v1',
  mode: 'original',
  fps: 30,
  width: 1920,
  height: 1080,
  duration: 4,
  style: { name: 'stub', cut_median_s: 0.79, palette: ['#0E5560'], treatments: ['teal'] },
  face: { source: 'work/cam_raw.mp4', share: 0.3 },
  beats: [
    { id: 'b1', t0: 0, t1: 1, device: 'tile_reveal', asset: 'assets/media/still_001.jpg', treatment: 'teal', caption: [['real', 0.15]] },
    { id: 'b2', t0: 1, t1: 2, device: 'broll', asset: 'assets/media/clip_001.mp4', media_start: 0, rate: 0.06 },
    { id: 'b3', t0: 2, t1: 3, device: 'face' },
    { id: 'b4', t0: 3, t1: 4, device: 'still', asset: 'assets/media/still_002.png', treatment: 'mono' },
  ],
  stats: { beats: 4, face_beats: 1, face_share: 0.25, images_per_minute: 60, keyword_beats: 0, stills: 2, clips: 1, words: 12 },
};

/**
 * Deterministic stand-ins for every stage. Each one writes exactly the artifact
 * the contract names, so the runner, the resume logic and the manifest can be
 * tested without a single subprocess.
 */
function fakeEngines({ failAt = null, withMusic = false } = {}) {
  const calls = {};
  const count = stage => { calls[stage] = (calls[stage] || 0) + 1; };
  const guard = stage => { if (failAt === stage) throw new Error(`${stage} exploded on purpose`); };

  return {
    id: 'fake-editor-v1',
    capabilities: () => ({ devices: [...EDITOR_DEVICES], tools: {}, cutOut: false }),
    calls,

    async probe(ctx) {
      count('probe'); guard('probe');
      ctx.project.writeJson('artifacts/probe.json', STUB_PROBE);
      return { artifact: 'artifacts/probe.json', probe: STUB_PROBE, metrics: { takeSeconds: 4 } };
    },

    async prepare(ctx) {
      count('prepare'); guard('prepare');
      writeArtifact(ctx.project, 'work/cam_raw.mp4', Buffer.alloc(2048, 1));
      writeArtifact(ctx.project, 'work/vo.wav', Buffer.alloc(1024, 2));
      return { artifact: 'work/cam_raw.mp4', metrics: { realFfmpeg: false } };
    },

    async transcribe(ctx) {
      count('transcribe'); guard('transcribe');
      const transcript = fixtureTranscript();
      ctx.project.writeJson('artifacts/transcript.json', transcript);
      return { artifact: 'artifacts/transcript.json', transcript, metrics: { words: transcript.words.length } };
    },

    async collectAssets(ctx) {
      count('assets'); guard('assets');
      ctx.project.writeJson('artifacts/assets.json', STUB_ASSETS);
      return { artifact: 'artifacts/assets.json', assets: STUB_ASSETS, metrics: { stills: 2, clips: 1 } };
    },

    async plan(ctx) {
      count('plan'); guard('plan');
      ctx.project.writeJson('artifacts/plan.json', STUB_PLAN);
      return { artifact: 'artifacts/plan.json', plan: STUB_PLAN, metrics: { beats: 4 } };
    },

    async build(ctx) {
      count('build'); guard('build');
      writeArtifact(ctx.project, 'comp/index.html', '<!doctype html><title>stub</title>');
      writeArtifact(ctx.project, 'comp/sfx-cues.txt', '0.10 ev1kit/click_3 0.8\n');
      writeArtifact(ctx.project, 'work/shots.json', '{"shots":4}\n');
      return { artifact: 'comp/index.html', cues: 1, metrics: { cues: 1 } };
    },

    async render(ctx) {
      count('render'); guard('render');
      writeArtifact(ctx.project, 'out/render.mp4', Buffer.alloc(4096, 4));
      return { artifact: 'out/render.mp4', metrics: { quality: ctx.options.quality } };
    },

    async mix(ctx) {
      count('mix'); guard('mix');
      writeArtifact(ctx.project, 'out/mixed.mp4', Buffer.alloc(4096, 5));
      if (!withMusic || !ctx.options.music_path) {
        return { artifact: 'out/mixed.mp4', skipped: true, reason: 'no music bed', metrics: { bed: false } };
      }
      return { artifact: 'out/mixed.mp4', metrics: { bed: true, under_lu: 5.5 } };
    },

    async finish(ctx) {
      count('finish'); guard('finish');
      writeArtifact(ctx.project, 'out/final.mp4', Buffer.alloc(6144, 6));
      return { artifact: 'out/final.mp4', metrics: { loudness: -14 } };
    },

    async validate(ctx) {
      count('validate'); guard('validate');
      const report = { ok: true, expected_duration: 4, output: { duration: 4, width: 1920, height: 1080 }, issues: [] };
      ctx.project.writeJson('artifacts/validate.json', report);
      return { artifact: 'artifacts/validate.json', report, metrics: { ratio: 1 } };
    },
  };
}

function setup({ music = false } = {}) {
  const jobsDir = tmpdir('vidmyo-editor-jobs-');
  const outputDir = tmpdir('vidmyo-editor-out-');
  const footage = makeFootage();
  const store = new JobStore(jobsDir);
  const service = new EditorService({ store, engines: fakeEngines() });
  const options = music ? { music_path: makeMusicBed() } : {};
  return { store, service, footage, outputDir, options };
}

/** Count governor traffic so "one lease per job" is a measured claim. */
function spyGovernor(store) {
  const counts = { acquire: 0, acquireAsync: 0, release: 0 };
  const { acquire, acquireAsync, release } = store.governor;
  store.governor.acquire = (...args) => { counts.acquire += 1; return acquire.apply(store.governor, args); };
  store.governor.acquireAsync = async (...args) => { counts.acquireAsync += 1; return acquireAsync.apply(store.governor, args); };
  store.governor.release = (...args) => { counts.release += 1; return release.apply(store.governor, args); };
  return counts;
}

function withEditorHome(fn) {
  const previous = process.env.VIDMYO_EDITOR_HOME;
  const home = tmpdir('vidmyo-editor-home-');
  process.env.VIDMYO_EDITOR_HOME = home;
  const restore = () => {
    if (previous === undefined) delete process.env.VIDMYO_EDITOR_HOME;
    else process.env.VIDMYO_EDITOR_HOME = previous;
  };
  let result;
  try {
    result = fn(home);
  } catch (error) {
    restore();
    throw error;
  }
  // Async bodies must keep the isolated home until they settle, otherwise a
  // concurrent run would write templates into the real ~/.vidmyo.
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ── 1. Contract validation ──────────────────────────────────────────────────

test('normalizeEditorOptions validates quality, pacing, face share and music path', () => {
  assert.throws(() => normalizeEditorOptions({ quality: 'ultra' }), /Quality must be one of/);
  assert.throws(() => normalizeEditorOptions({ quality: 'BEST' }), /Quality must be one of/);
  assert.throws(() => normalizeEditorOptions({ pacing: 'fast' }), /Pacing must be/);
  assert.throws(() => normalizeEditorOptions({ face_share: 2 }), /between 0 and 0.8/);
  assert.throws(() => normalizeEditorOptions({ music_path: 'relative/bed.mp3' }), /absolute path/);
  assert.throws(() => normalizeEditorOptions({ music_path: '/tmp/bed.pdf' }), /audio file/);
  assert.throws(() => normalizeEditorOptions({ mode: 'cinema' }), /original.*custom/);
  assert.throws(() => normalizeEditorOptions({ engine: 'v9' }), /Unknown editor engine/);

  const options = normalizeEditorOptions({ quality: 'high', face_share: 0.4, mode: 'custom' });
  assert.equal(options.quality, 'high');
  assert.equal(options.face_share, 0.4);
  assert.equal(options.mode, 'custom');
  assert.deepEqual(options.examples, []);
  assert.ok(Object.isFrozen(options));
  for (const quality of EDITOR_QUALITIES) {
    assert.equal(normalizeEditorOptions({ quality }).quality, quality);
  }
});

test('EditorService.create rejects relative paths, missing footage, bad quality and foreign templates', () => {
  withEditorHome(() => {
    const { service, footage, outputDir } = setup();

    assert.throws(() => service.create({ input: 'footage' }), /absolute path/);
    assert.throws(() => service.create({ input: path.join(footage, 'does-not-exist') }), /Footage not found/);
    assert.throws(() => service.create({ input: footage, options: { quality: 'ultra' } }), /Quality must be one of/);

    // A template saved by another (future) engine must be refused, not silently used.
    const templates = new EditorTemplateStore();
    const dir = templates.pathFor('future-style');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify({
      contract_version: 1,
      kind: 'vidmyo.editor.template',
      id: 'future-style',
      name: 'Future',
      engine: 'v9',
      created_at: new Date().toISOString(),
      examples: [],
      profile: { cut_median_s: 0.4 },
    }));
    assert.throws(
      () => service.create({ input: footage, options: { engine: 'v1', template_id: 'future-style' } }),
      /different engine/,
    );

    const created = service.create({ input: footage, output: outputDir });
    assert.equal(created.job.type, EDITOR_JOB_TYPE);
    assert.equal(created.job.state, 'queued');
    assert.equal(created.project.manifest.stages.length, EDITOR_STAGES.length);
    assert.equal(created.project.manifest.options.engine, 'v1');
    assert.equal(EditorProject.exists(created.project.dir), true);
    assert.equal(created.project.stageStatus('probe'), 'pending');
    assert.deepEqual(created.project.nextStage(), 'probe');
    assert.ok(fs.existsSync(path.join(created.project.dir, 'manifest.json')));
  });
});

// ── 2. Stage planning ───────────────────────────────────────────────────────

test('the pipeline is data: ten chained stages, one artifact each, all distinct', () => {
  assert.deepEqual([...EDITOR_STAGES], [
    'probe', 'prepare', 'transcribe', 'assets', 'plan', 'build', 'render', 'mix', 'finish', 'validate',
  ]);
  assert.deepEqual(planStages({}), [...EDITOR_STAGES]);
  assert.deepEqual(planStages({ music_path: '/tmp/bed.mp3' }), [...EDITOR_STAGES]);
  const artifacts = new Set();
  for (const stage of EDITOR_STAGES) {
    const artifact = EDITOR_STAGE_ARTIFACTS[stage];
    assert.equal(typeof artifact, 'string', `${stage} must declare an artifact`);
    assert.equal(artifacts.has(artifact), false, `${artifact} is used twice`);
    artifacts.add(artifact);
    for (const dependency of STAGE_DEPENDENCIES[stage]) {
      assert.ok(EDITOR_STAGES.includes(dependency), `${stage} depends on unknown ${dependency}`);
      assert.ok(
        EDITOR_STAGES.indexOf(dependency) < EDITOR_STAGES.indexOf(stage),
        `${dependency} must run before ${stage}`,
      );
    }
  }
  assert.deepEqual(STAGE_DEPENDENCIES.probe, []);
  assert.deepEqual(STAGE_DEPENDENCIES.validate, ['finish']);
});

// ── 3. The planner (real engine, no subprocess) ─────────────────────────────

function plannerContext(options = {}) {
  const dir = tmpdir('vidmyo-editor-plan-');
  const project = EditorProject.create(dir, {
    input: { type: 'folder', path: '/tmp/footage', name: 'footage' },
    options: normalizeEditorOptions(options),
  });
  return {
    project,
    options: project.manifest.options,
    template: null,
    signal: null,
    log: () => {},
    warn: () => {},
  };
}

test('plan emits a deterministic EDL inside the 0.6–1.5 s beat contract', async () => {
  const engines = createEditorEngines({ ffmpeg: '/bin/true', ffprobe: '/bin/true', python: '/bin/true', hyperframes: '/bin/true' });
  const ctx = plannerContext({ face_share: 0.3 });
  ctx.project.writeJson('artifacts/probe.json', { duration: 42.5, fps: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true });
  ctx.project.writeJson('artifacts/transcript.json', fixtureTranscript(42.5));
  ctx.project.writeJson('artifacts/assets.json', STUB_ASSETS);

  const first = await engines.plan(ctx);
  const second = await engines.plan(ctx);
  const plan = first.plan;

  // Deterministic: the same inputs always produce the same beats.
  assert.deepEqual(first.plan.beats, second.plan.beats);

  assert.equal(plan.version, 1);
  assert.equal(plan.engine, 'v1');
  assert.equal(plan.fps, 30);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.equal(plan.duration, 42.5);
  assert.deepEqual(validatePlanDocument(plan), []);

  assert.ok(plan.beats.length >= 30, 'a 42.5 s take at ~0.79 s must hold ~54 beats');
  assert.ok(plan.stats.images_per_minute >= 60 && plan.stats.images_per_minute <= 180);

  let cursor = 0;
  for (const beat of plan.beats) {
    // Contiguous, on the 30 fps frame grid, inside the cut window.
    assert.ok(Math.abs(beat.t0 - cursor) < 1e-6, `${beat.id} must start where the previous beat ended`);
    const length = beat.t1 - beat.t0;
    assert.ok(length >= 0.6 - 1e-6 && length <= 1.5 + 1e-6, `${beat.id} is ${length.toFixed(3)}s`);
    assert.ok(Math.abs(Math.round(beat.t0 * 30) / 30 - beat.t0) < 1e-6, `${beat.id} is off the frame grid`);
    // Never a beat without a device; material beats always name a real asset.
    assert.ok(EDITOR_DEVICES.includes(beat.device), `${beat.id} has device ${beat.device}`);
    if (beat.device === 'face') assert.equal(beat.asset, undefined);
    else assert.ok(beat.asset, `${beat.id} is a material beat without an asset`);
    if (beat.treatment) assert.ok(EDITOR_TREATMENTS.includes(beat.treatment));
    // Captions ride the words that fall inside the beat, at absolute onsets.
    for (const [word, at] of beat.caption || []) {
      assert.equal(typeof word, 'string');
      assert.ok(at >= beat.t0 - 1e-6 && at <= beat.t1, `${beat.id} caption ${word} at ${at}`);
    }
    if (beat.keyword) {
      assert.ok(['key', 'title', 'shock', 'mega'].includes(beat.keyword.kind));
      assert.ok(beat.keyword.text.length >= 4);
      assert.ok(beat.keyword.at >= beat.t0 && beat.keyword.at <= beat.t1);
    }
    cursor = beat.t1;
  }
  assert.equal(plan.beats[plan.beats.length - 1].t1, plan.duration);

  // Face share follows the option, and moving clips are used when they exist.
  assert.ok(Math.abs(plan.stats.face_share - 0.3) <= 0.08, `face share was ${plan.stats.face_share}`);
  assert.equal(plan.face.share, 0.3);
  assert.equal(plan.face.source, 'work/cam_raw.mp4');
  assert.ok(plan.beats.some(beat => beat.device === 'broll'), 'a clip in the folder must end up on screen');
  assert.ok(plan.beats.some(beat => beat.device === 'face'));
  assert.ok(plan.beats.some(beat => beat.caption));
  // …but never two face beats back to back.
  for (let index = 1; index < plan.beats.length; index += 1) {
    assert.equal(plan.beats[index].device === 'face' && plan.beats[index - 1].device === 'face', false);
  }
});

test('plan still produces a renderable EDL with zero pictures in the folder', async () => {
  const engines = createEditorEngines({ ffmpeg: '/bin/true', ffprobe: '/bin/true', python: '/bin/true', hyperframes: '/bin/true' });
  const ctx = plannerContext({});
  ctx.project.writeJson('artifacts/probe.json', { duration: 12, fps: 30, width: 1920, height: 1080 });
  ctx.project.writeJson('artifacts/transcript.json', fixtureTranscript(12));
  ctx.project.writeJson('artifacts/assets.json', { face: 'work/cam_raw.mp4', stills: [], clips: [], counts: { stills: 0, clips: 0 } });

  const { plan } = await engines.plan(ctx);
  assert.deepEqual(validatePlanDocument(plan), []);
  assert.ok(plan.beats.length > 0);
  assert.deepEqual([...new Set(plan.beats.map(beat => beat.device))], ['face']);
  assert.equal(plan.beats[plan.beats.length - 1].t1, 12);
  assert.equal(plan.stats.face_share, 1);
});

test('plan respects a custom style profile and the long pacing', async () => {
  const engines = createEditorEngines({ ffmpeg: '/bin/true', ffprobe: '/bin/true', python: '/bin/true', hyperframes: '/bin/true' });
  const ctx = plannerContext({ pacing: 'long', face_share: 0.25 });
  ctx.template = { profile: { shot_median_s: 1.1, palette: ['#101010', '#fafafa'], caption_size: 48 } };
  ctx.project.writeJson('artifacts/probe.json', { duration: 20, fps: 30, width: 1920, height: 1080 });
  ctx.project.writeJson('artifacts/transcript.json', fixtureTranscript(20));
  ctx.project.writeJson('artifacts/assets.json', STUB_ASSETS);

  const { plan } = await engines.plan(ctx);
  assert.deepEqual(validatePlanDocument(plan), []);
  assert.equal(plan.style.caption_size_px, 48);
  assert.deepEqual(plan.style.palette, ['#101010', '#fafafa']);
  // 'long' stretches the median but never leaves the 0.6–1.5 s window.
  assert.ok(plan.style.cut_median_s > 0.79);
  for (const beat of plan.beats) assert.ok(beat.t1 - beat.t0 <= 1.5 + 1e-6);

  // Same transcript at the reference pace holds more beats than the long pace.
  const reference = buildPlanDocument({
    probe: { duration: 20 },
    transcript: fixtureTranscript(20),
    assets: STUB_ASSETS,
    options: { pacing: 'reference', face_share: 0.25 },
    style: EDITOR_V1_PROFILE,
  });
  assert.ok(reference.beats.length > plan.beats.length);
});

test('planBeatBoundaries always lands inside the cut window', () => {
  for (const duration of [0.8, 1.2, 2, 7.3, 42.5, 100, 733]) {
    const bounds = planBeatBoundaries({ duration });
    assert.equal(bounds[0], 0);
    assert.ok(Math.abs(bounds[bounds.length - 1] - duration) < 1e-6);
    for (let index = 1; index < bounds.length; index += 1) {
      const length = bounds[index] - bounds[index - 1];
      assert.ok(length >= 0.6 - 1e-6 && length <= 1.5 + 1e-6, `${duration}s produced a ${length.toFixed(3)}s beat`);
    }
  }
});

// ── 4. A full run through the runner ────────────────────────────────────────

test('runEditorJob drives every stage to done/skipped and records real metrics', async () => {
  withEditorHome(async () => {
    const { store, service, footage, outputDir } = setup();
    const counts = spyGovernor(store);
    const engines = fakeEngines();
    const { job, project } = service.create({ input: footage, output: outputDir });
    const events = [];

    const finished = await runEditorJob(store, job.id, {
      engines,
      onEvent: event => events.push(event),
    });

    assert.equal(finished.state, 'done');
    assert.equal(finished.error, null);

    const summary = editorJobSummary(finished, { project: EditorProject.load(project.dir) });
    assert.equal(summary.progress, 100);
    assert.equal(summary.stages.length, EDITOR_STAGES.length);
    for (const stage of summary.stages) {
      assert.ok(['done', 'skipped'].includes(stage.status), `${stage.id} ended ${stage.status}`);
      assert.equal(EDITOR_STAGES.includes(stage.id), true);
    }
    // Every stage ran exactly once, in one job.
    for (const stage of EDITOR_STAGES) assert.equal(engines.calls[stage], 1, `${stage} ran ${engines.calls[stage]} times`);

    // No music bed → mix is skipped with a reason and still leaves its artifact.
    const mixStage = summary.stages.find(stage => stage.id === 'mix');
    assert.equal(mixStage.status, 'skipped');
    assert.equal(mixStage.error, 'no music bed');
    assert.equal(mixStage.artifact, 'out/mixed.mp4');

    // Artifacts on disk, one per stage.
    for (const [stage, artifact] of Object.entries(EDITOR_STAGE_ARTIFACTS)) {
      assert.ok(EditorProject.load(project.dir).hasArtifact(artifact), `${stage} did not write ${artifact}`);
    }
    assert.ok(fs.existsSync(path.join(project.dir, 'comp', 'sfx-cues.txt')));
    assert.ok(fs.existsSync(path.join(project.dir, 'out', 'final.mp4')));

    // Per-stage metrics + total on the job.
    const metrics = finished.checkpoints.metrics;
    assert.equal(typeof metrics, 'object');
    assert.equal(Object.keys(metrics.stages).length, EDITOR_STAGES.length);
    for (const stage of EDITOR_STAGES) assert.equal(typeof metrics.stages[stage], 'number', `${stage} has no timing`);
    assert.equal(typeof metrics.totalMs, 'number');
    assert.equal(metrics.sourceDurationSeconds, 4);
    assert.equal(metrics.beats, 4);
    assert.ok(Array.isArray(metrics.outputs) && metrics.outputs.some(output => output.artifact === 'out/final.mp4'));

    // Outputs are registered on the job and the governor slot was given back.
    assert.ok(finished.artifacts.some(artifact => artifact.path.endsWith('final.mp4')));
    assert.equal(finished.checkpoints.leaseToken, null);
    // One admission for the whole job, never re-acquired per stage/child.
    assert.equal(counts.acquire + counts.acquireAsync, 1);
    assert.ok(counts.release >= 1);

    // Event stream: every stage, then done — and no error.
    assert.ok(events.some(event => event.event === 'done'));
    assert.equal(events.some(event => event.event === 'error'), false);
    assert.equal(events.filter(event => event.event === 'stage' && event.status === 'running').length, EDITOR_STAGES.length);

    // Job records are terminal history: a retry cannot revive a finished job.
    assert.throws(() => service.retry(job.id), /already completed every stage/);
  });
});

test('runEditorJob marks mix done when a music bed is configured', async () => {
  await withEditorHome(async () => {
    const jobsDir = tmpdir('vidmyo-editor-jobs-');
    const outputDir = tmpdir('vidmyo-editor-out-');
    const store = new JobStore(jobsDir);
    const service = new EditorService({ store, engines: fakeEngines({ withMusic: true }) });
    const { job, project } = service.create({
      input: makeFootage(),
      output: outputDir,
      options: { music_path: makeMusicBed() },
    });
    const finished = await runEditorJob(store, job.id, { engines: fakeEngines({ withMusic: true }) });
    assert.equal(finished.state, 'done');
    const summary = editorJobSummary(finished, { project: EditorProject.load(project.dir) });
    assert.equal(summary.stages.find(stage => stage.id === 'mix').status, 'done');
    assert.equal(summary.stages.every(stage => ['done', 'skipped'].includes(stage.status)), true);
  });
});

test('a failing stage fails the job, records the error and keeps finished work', async () => {
  await withEditorHome(async () => {
    const { store, service, footage, outputDir } = setup();
    const engines = fakeEngines({ failAt: 'build' });
    const { job, project } = service.create({ input: footage, output: outputDir });

    const finished = await runEditorJob(store, job.id, { engines });
    assert.equal(finished.state, 'error');
    assert.match(finished.error, /build: build exploded on purpose/);

    const summary = editorJobSummary(finished, { project: EditorProject.load(project.dir) });
    const statuses = Object.fromEntries(summary.stages.map(stage => [stage.id, stage.status]));
    assert.equal(statuses.probe, 'done');
    assert.equal(statuses.plan, 'done');
    assert.equal(statuses.build, 'failed');
    assert.equal(statuses.render, 'pending');
    // The failure did not throw away the expensive stages.
    assert.equal(EditorProject.load(project.dir).hasArtifact('artifacts/transcript.json'), true);
    assert.equal(Object.keys(finished.checkpoints.metrics.stages).includes('build'), true);
  });
});

// ── 5. Resume ───────────────────────────────────────────────────────────────

test('a second run over the same project re-runs only the stage whose artifact is missing', async () => {
  await withEditorHome(async () => {
    const jobsDir = tmpdir('vidmyo-editor-jobs-');
    const outputDir = tmpdir('vidmyo-editor-out-');
    const store = new JobStore(jobsDir);
    const service = new EditorService({ store, engines: fakeEngines() });
    const { job, project } = service.create({ input: makeFootage(), output: outputDir });

    const first = await runEditorJob(store, job.id, { engines: fakeEngines() });
    assert.equal(first.state, 'done');

    // Simulate a crash mid-`finish`: the master is gone and the stage is pending.
    fs.rmSync(path.join(project.dir, 'out', 'final.mp4'));
    const reloaded = EditorProject.load(project.dir);
    reloaded.setStage('finish', { status: 'pending', artifact: null });
    assert.equal(EditorProject.load(project.dir).nextStage(), 'finish');

    const retry = service.retry(job.id);
    assert.notEqual(retry.job.id, job.id);
    const engines = fakeEngines();
    const second = await runEditorJob(store, retry.job.id, { engines });

    assert.equal(second.state, 'done');
    // Only the missing stage ran; everything else was hydrated from disk.
    assert.equal(engines.calls.finish, 1);
    for (const stage of ['probe', 'prepare', 'transcribe', 'assets', 'plan', 'build', 'render', 'mix', 'validate']) {
      assert.equal(engines.calls[stage], undefined, `${stage} was re-run even though its artifact existed`);
    }
    assert.equal(EditorProject.load(project.dir).hasArtifact('out/final.mp4'), true);

    // Third run: the artifact exists but the manifest says pending (a crash
    // between stages). Hydration must mark it done and run nothing at all.
    const third = EditorProject.load(project.dir);
    third.setStage('plan', { status: 'pending', artifact: null });
    const enginesAgain = fakeEngines();
    const recovered = store.create({
      type: EDITOR_JOB_TYPE,
      params: { ...retry.job.params, surface: 'editor' },
    });
    const resumed = await runEditorJob(store, recovered.id, { engines: enginesAgain });
    assert.equal(resumed.state, 'done');
    assert.deepEqual(enginesAgain.calls, {});
    assert.equal(EditorProject.load(project.dir).stageStatus('plan'), 'done');
  });
});

// ── 6. Templates ────────────────────────────────────────────────────────────

test('EditorTemplateStore round-trips a profile through VIDMYO_EDITOR_HOME', () => {
  withEditorHome(home => {
    const store = new EditorTemplateStore();
    const profile = { cut_median_s: 0.52, cuts_per_minute: 112, palette: ['#0b0b0b', '#e6e1d8'], treatment_mix: { mono: 0.5 } };
    const saved = store.save({ name: 'Cold open  faster', profile, examples: ['https://www.youtube.com/watch?v=abc'] });

    assert.match(saved.id, /^cold-open-faster-[0-9a-f]{6}$/);
    assert.equal(saved.engine, 'v1');
    assert.equal(fs.existsSync(path.join(home, 'templates', saved.id, 'template.json')), true);

    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].cut_median_s, 0.52);
    assert.equal(listed[0].cuts_per_minute, 112);
    assert.deepEqual(listed[0].palette, ['#0b0b0b', '#e6e1d8']);

    const loaded = store.get(saved.id);
    assert.deepEqual(loaded.profile, profile);
    assert.deepEqual(loaded.examples, ['https://www.youtube.com/watch?v=abc']);
    assert.deepEqual(store.list({ engine: 'v1' }).map(item => item.id), [saved.id]);
    assert.deepEqual(store.list({ engine: 'v2' }), []);

    assert.throws(() => store.save({ name: '', profile }), /needs a name/);
    assert.throws(() => store.save({ name: 'x' }), /style profile/);
    assert.throws(() => store.get('../escape'), /Invalid template id/);

    assert.equal(store.remove(saved.id), true);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(saved.id), null);
  });
});

test('a saved template drives the planner through mergeStyleProfile', () => {
  withEditorHome(() => {
    const templates = new EditorTemplateStore();
    const saved = templates.save({
      name: 'Measured',
      profile: { shot_median_s: 0.62, caption_size: 54, palette: ['#111111', '#EEEEEE'] },
    });
    const loaded = templates.get(saved.id);
    const merged = mergeStyleProfile(EDITOR_V1_PROFILE, loaded.profile);
    const plan = buildPlanDocument({
      probe: { duration: 10 },
      transcript: fixtureTranscript(10),
      assets: STUB_ASSETS,
      options: normalizeEditorOptions({}),
      style: merged,
    });
    assert.equal(plan.style.caption_size_px, 54);
    assert.deepEqual(plan.style.palette, ['#111111', '#EEEEEE']);
    assert.ok(plan.style.cut_median_s > 0.6 && plan.style.cut_median_s < 0.79);
    assert.deepEqual(validatePlanDocument(plan), []);
  });
});

// ── 7. Style profile merging ────────────────────────────────────────────────

test('EDITOR_V1_PROFILE carries the measured V1 look', () => {
  assert.equal(EDITOR_V1_PROFILE.cut_median_s, 0.79);
  assert.deepEqual(EDITOR_V1_PROFILE.cut_range_s, [0.56, 0.79]);
  assert.deepEqual(EDITOR_V1_PROFILE.images_per_minute, [60, 180]);
  assert.equal(EDITOR_V1_PROFILE.caption.font, 'Inter');
  assert.equal(EDITOR_V1_PROFILE.caption.weight, 600);
  assert.equal(EDITOR_V1_PROFILE.caption.size_px, 62);
  assert.deepEqual(EDITOR_V1_PROFILE.face_share_range, [0.25, 0.35]);
  assert.equal(EDITOR_V1_PROFILE.face_share, 0.3);
  assert.ok(EDITOR_V1_PROFILE.treatment_mix.teal > 0);
  assert.ok(EDITOR_V1_PROFILE.treatment_mix.mono > 0);
  assert.ok(EDITOR_V1_PROFILE.treatment_mix.natural > 0);
  assert.ok(EDITOR_V1_PROFILE.treatment_mix.warm > 0);
  assert.ok(EDITOR_V1_PROFILE.palette.includes('#0E5560'));
  assert.ok(Object.isFrozen(EDITOR_V1_PROFILE));
  assert.ok(Object.isFrozen(EDITOR_V1_PROFILE.caption));
});

test('mergeStyleProfile: custom wins on its keys, unknown keys are ignored, base is untouched', () => {
  const custom = {
    shot_median_s: 0.5,
    caption_size: 48,
    palette: ['#101010'],
    treatment_mix: { teal: 0.5 },
    face_share: 0.5,
    not_a_profile_key: 42,
    caption: { weight: 700 },
  };
  const merged = mergeStyleProfile(EDITOR_V1_PROFILE, custom);

  assert.equal(merged.cut_median_s, 0.5, 'shot_median_s maps onto the planner key');
  assert.equal(merged.caption.size_px, 48, 'caption_size maps onto caption.size_px');
  assert.equal(merged.caption.weight, 700, 'nested objects merge');
  assert.equal(merged.caption.font, 'Inter', 'untouched nested keys survive');
  assert.deepEqual(merged.palette, ['#101010']);
  assert.equal(merged.treatment_mix.teal, 0.5);
  assert.equal(merged.treatment_mix.mono, 0.18, 'untouched treatment shares survive');
  assert.equal(merged.face_share, 0.5);
  assert.equal('not_a_profile_key' in merged, false, 'unknown keys are ignored');
  assert.equal(EDITOR_V1_PROFILE.cut_median_s, 0.79, 'the base profile is never mutated');
  assert.deepEqual(custom.palette, ['#101010'], 'the custom profile is never mutated');
  assert.ok(Object.isFrozen(merged));

  // Nulls never clobber a measured value; out-of-range medians are clamped.
  assert.equal(mergeStyleProfile(EDITOR_V1_PROFILE, { cut_median_s: null }).cut_median_s, 0.79);
  assert.equal(mergeStyleProfile(EDITOR_V1_PROFILE, { cut_median_s: 5 }).cut_median_s, 3);
  assert.equal(mergeStyleProfile(EDITOR_V1_PROFILE, { cut_median_s: 0.1 }).cut_median_s, 0.2);
  assert.equal(mergeStyleProfile(EDITOR_V1_PROFILE, { cut_median_s: 'fast' }).cut_median_s, 0.79);
  assert.equal(mergeStyleProfile(EDITOR_V1_PROFILE, null).cut_median_s, 0.79);
  assert.deepEqual(mergeStyleProfile(EDITOR_V1_PROFILE, { palette: null }).palette, EDITOR_V1_PROFILE.palette);
});

test('a measured median below the beat floor still produces beats inside the window', () => {
  const fast = mergeStyleProfile(EDITOR_V1_PROFILE, { shot_median_s: 0.4 });
  assert.equal(fast.cut_median_s, 0.4, 'the measurement is kept as measured');
  const plan = buildPlanDocument({
    probe: { duration: 10 },
    transcript: fixtureTranscript(10),
    assets: STUB_ASSETS,
    options: normalizeEditorOptions({}),
    style: fast,
  });
  for (const beat of plan.beats) {
    assert.ok(beat.t1 - beat.t0 >= 0.6 - 1e-6 && beat.t1 - beat.t0 <= 1.5 + 1e-6);
  }
  assert.deepEqual(validatePlanDocument(plan), []);
});

test('mergeStyleProfile reads a real analyser document (numbers under `style`)', () => {
  // Shape produced by driver/analyze_examples.py (verified against a real run).
  const analysis = {
    version: 1,
    kind: 'vidmyo.editor.style-profile',
    contract: 'docs/editor-v1.md §4b / §6',
    style: {
      name: 'custom (1 example)',
      cut_median_s: 1.5,
      cuts_per_minute: 40,
      burst_ratio: 0.02,
      palette: ['#0E5560', '#F1F0EC', '#060607', '#F2030A', '#D9822B', '#FFE04A'],
      palette_weights: [{ hex: '#0E5560', weight: 0.5 }],
      treatment_mix: { teal: 0.132, mono: 0, warm: 0.602, natural: 0.266 },
      caption_size_hint: 70,
      face_share_hint: 0.34,
      mean_saturation: 0.4,
      sample_count: 120,
    },
    examples: [{ name: 'ref.mp4', duration: 12 }],
  };
  const merged = mergeStyleProfile(EDITOR_V1_PROFILE, analysis);
  assert.equal(merged.cut_median_s, 1.5);
  assert.equal(merged.cuts_per_minute, 40);
  assert.equal(merged.burst_ratio, 0.02);
  assert.equal(merged.caption.size_px, 70, 'caption_size_hint is a soft caption override');
  assert.equal(merged.face_share, 0.34, 'face_share_hint is a soft face override');
  assert.equal(merged.treatment_mix.warm, 0.602);
  assert.equal(merged.treatment_mix.halftone, 0.14, 'unmeasured treatments keep the V1 default');
  assert.equal('examples' in merged, false);
  assert.equal('mean_saturation' in merged, false);
});

// ── 8. Style analysis (examples → profile) ──────────────────────────────────

test('runEditorAnalysisJob copies files, downloads URLs and records the profile', async () => {
  await withEditorHome(async () => {
    const store = new JobStore(tmpdir('vidmyo-editor-analysis-jobs-'));
    const service = new EditorService({ store, engines: { id: 'fake' }, projectsDir: tmpdir('vidmyo-editor-analysis-') });
    const exampleDir = tmpdir('vidmyo-editor-example-');
    const localExample = path.join(exampleDir, 'ref.mp4');
    fs.writeFileSync(localExample, Buffer.alloc(3072, 8));

    const { job, dir } = service.createAnalysis({
      urls: ['https://www.youtube.com/watch?v=abc'],
      videos: [localExample],
      name: 'Reference style',
    });

    const seen = { downloads: [], analyzed: null };
    const engines = {
      id: 'fake-analysis',
      async downloadExample({ url, dir: target }) {
        assert.match(url, /^https:\/\//);
        const file = path.join(target, 'example_1.mp4');
        fs.writeFileSync(file, Buffer.alloc(2048, 4));
        seen.downloads.push(url);
        return { file, bytes: 2048, duration: 42, url };
      },
      async analyzeExamples({ paths, workDir }) {
        seen.analyzed = { paths, workDir };
        const profile = { version: 1, style: { cut_median_s: 0.52, palette: ['#101010'] } };
        fs.writeFileSync(path.join(workDir, 'style-profile.json'), JSON.stringify(profile));
        fs.writeFileSync(path.join(workDir, 'contact-sheet.jpg'), Buffer.alloc(128, 2));
        return { profile, contactSheet: path.join(workDir, 'contact-sheet.jpg'), examples: paths };
      },
    };

    const finished = await runEditorAnalysisJob(store, job.id, { engines });
    assert.equal(finished.state, 'done');
    assert.deepEqual(seen.downloads, ['https://www.youtube.com/watch?v=abc']);
    assert.equal(seen.analyzed.paths.length, 2, 'the downloaded and the local example are both analysed');
    assert.equal(seen.analyzed.workDir, dir);

    assert.equal(Object.keys(finished.checkpoints.metrics.stages).length, 2);
    assert.equal(typeof finished.checkpoints.metrics.totalMs, 'number');
    assert.equal(fs.existsSync(path.join(dir, 'examples', 'index.json')), true);

    const analysis = service.getAnalysis(job.id);
    assert.equal(analysis.profile.style.cut_median_s, 0.52);
    assert.ok(finished.artifacts.some(artifact => artifact.path.endsWith('style-profile.json')));
    assert.ok(finished.artifacts.some(artifact => artifact.path.endsWith('contact-sheet.jpg')));
  });
});
