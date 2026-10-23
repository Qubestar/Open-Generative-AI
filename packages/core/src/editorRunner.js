// Editor runner — drives an `editor` job through its stage list, and an
// `editor-analysis` job through the style-analysis stages.
//
// Design rules (inherited from translateRunner.js, deliberately):
//   - The JOB holds one heavy governor lease for the whole pipeline (concurrency 1).
//     Children inherit the job's AbortSignal and never re-acquire the governor, so
//     releasing a child can never drop the job's exclusive slot.
//   - Every stage writes exactly one artifact. A stage whose artifact is already
//     on disk is hydrated as done, so a retry (a NEW job over the SAME project —
//     job records are terminal history) never redoes work.
//   - `mix` degrades: a music bed that fails to mix still yields out/mixed.mp4
//     (a copy of the render) and the stage is recorded as skipped with a reason.
//     No other stage is allowed to fail silently.
//   - Cancellation is honoured between stages and inside every child.
//   - Per-stage timings land in job.checkpoints.metrics.stages plus totalMs, so
//     performance claims come from measured runs.

import fs from 'node:fs';
import path from 'node:path';

import {
  EditorProject,
  EditorTemplateStore,
  EDITOR_JOB_TYPE,
  EDITOR_ANALYSIS_JOB_TYPE,
  EDITOR_ANALYSIS_STAGES,
  EDITOR_STAGE_ARTIFACTS,
  EDITOR_STAGES,
} from './editor.js';

/** Where an analysis job records its downloaded examples. */
const ANALYSIS_ARTIFACTS = {
  download: 'examples/index.json',
  analyze: 'style-profile.json',
};

const ANALYSIS_LABELS = {
  download: 'Fetching the examples',
  analyze: 'Measuring the style',
};

const JOB_OUTPUTS = [
  { artifact: 'out/final.mp4', kind: 'final_video' },
  { artifact: 'out/mixed.mp4', kind: 'mixed_video' },
  { artifact: 'out/render.mp4', kind: 'render' },
  { artifact: 'artifacts/plan.json', kind: 'plan' },
  { artifact: 'artifacts/transcript.json', kind: 'transcript' },
  { artifact: 'artifacts/validate.json', kind: 'validation' },
  { artifact: 'comp/index.html', kind: 'composition' },
  { artifact: 'work/cam_raw.mp4', kind: 'camera_plate' },
];

function totalOf(timings) {
  return Object.values(timings).reduce((sum, value) => sum + value, 0);
}

function artifactOf(stage, result) {
  if (result?.artifact) return result.artifact;
  return EDITOR_STAGE_ARTIFACTS[stage] || null;
}

function warnSafely(context, message) {
  try { return context.warn(message); } catch { return null; }
}

/** Read whatever a finished stage left behind so a resumed job has its inputs. */
function hydrate(context) {
  const { project } = context;
  const read = relative => {
    try { return project.hasArtifact(relative) ? project.readJson(relative) : null; } catch { return null; }
  };
  const status = id => project.manifest.stages.find(entry => entry.id === id)?.status;
  context.probe = read('artifacts/probe.json');
  context.transcript = read('artifacts/transcript.json');
  context.assets = read('artifacts/assets.json');
  context.plan = read('artifacts/plan.json');
  context.rendered = status('render') === 'done' && project.hasArtifact('out/render.mp4') ? { artifact: 'out/render.mp4' } : null;
  context.mixed = project.hasArtifact('out/mixed.mp4') ? { artifact: 'out/mixed.mp4' } : null;
  context.final = project.hasArtifact('out/final.mp4') ? { artifact: 'out/final.mp4' } : null;
  context.validated = read('artifacts/validate.json');
}

function applyResult(stage, context, result) {
  switch (stage) {
    case 'probe': context.probe = result?.probe || null; break;
    case 'prepare': context.prepared = result || null; break;
    case 'transcribe': context.transcript = result?.transcript || null; break;
    case 'assets': context.assets = result?.assets || null; break;
    case 'plan': context.plan = result?.plan || null; break;
    case 'build': context.built = result || null; break;
    case 'render': context.rendered = { artifact: artifactOf('render', result) }; break;
    case 'mix': context.mixed = { artifact: artifactOf('mix', result) }; break;
    case 'finish': context.final = { artifact: artifactOf('finish', result) }; break;
    case 'validate': context.validated = result?.report || null; break;
    default: break;
  }
}

/**
 * A music bed that fails must not throw away a finished picture: fall back to the
 * plain render and let the stage be recorded as skipped.
 */
function degradeMix(project, error) {
  const render = project.artifactPath('out/render.mp4');
  const mixed = project.artifactPath('out/mixed.mp4');
  if (!fs.existsSync(render)) return false;
  try {
    fs.mkdirSync(path.dirname(mixed), { recursive: true });
    fs.copyFileSync(render, mixed);
  } catch {
    return false;
  }
  return `the music mix failed (${String(error?.message || error).slice(0, 300)}); the picture was kept without the bed`;
}

function stageMetrics(timings) {
  return { stages: { ...timings }, totalMs: totalOf(timings) };
}

// Stage ids in the manifest vs the engine method that implements them. `assets`
// is the stage name; `collectAssets` is the engine's method (docs/editor-v1.md §5).
const STAGE_HANDLERS = {
  probe: 'probe',
  prepare: 'prepare',
  transcribe: 'transcribe',
  assets: 'collectAssets',
  plan: 'plan',
  build: 'build',
  render: 'render',
  mix: 'mix',
  finish: 'finish',
  validate: 'validate',
};

export async function runEditorJob(store, jobId, {
  engines,
  signal = null,
  onEvent = null,
  waitForSlotMs = 10 * 60 * 1000,
} = {}) {
  if (!engines) throw new Error('runEditorJob requires editor engines');
  const job = store.get(jobId);
  if (!job) throw new Error(`No such job: ${jobId}`);
  if (job.type !== EDITOR_JOB_TYPE) throw new Error(`Job ${jobId} is not an editor job`);
  const projectDir = job.params?.projectDir;
  if (!projectDir || !EditorProject.exists(projectDir)) throw new Error('The editor project for that job is missing.');
  const project = EditorProject.load(projectDir);

  const emit = payload => {
    if (typeof onEvent !== 'function') return;
    try { onEvent({ job_id: jobId, ...payload }); } catch { /* observers must not break the run */ }
  };
  const log = message => { store.log(jobId, message); emit({ event: 'log', message: String(message) }); };

  // ── Admission (heavy, once for the whole job) ────────────────────────────
  if (store.governor && !store.get(jobId).checkpoints?.leaseToken) {
    try {
      await store.admitAsync(jobId, { resourceClass: 'heavy', waitForSlotMs });
    } catch (error) {
      store.setState(jobId, 'error', { error: `Governor admission denied: ${error.message}`, admit: false });
      emit({ event: 'error', error: error.message });
      return store.get(jobId);
    }
  }
  if (store.get(jobId).state === 'queued') {
    store.setState(jobId, 'running', { admit: false });
  }
  if (store.get(jobId).state !== 'running') {
    emit({ event: 'error', error: store.get(jobId).error || 'job could not start' });
    return store.get(jobId);
  }

  // ── Template (the measured style this run must match) ────────────────────
  let template = null;
  const templateId = project.manifest.options?.template_id;
  if (templateId) {
    try {
      template = new EditorTemplateStore().get(templateId);
      if (!template) throw new Error('not found');
    } catch (error) {
      template = null;
      log(`template ${templateId} could not be loaded (${error.message}); the original V1 look is used`);
    }
  }

  const context = {
    jobId,
    project,
    options: project.manifest.options,
    template,
    probe: null,
    prepared: null,
    transcript: null,
    assets: null,
    plan: null,
    built: null,
    rendered: null,
    mixed: null,
    final: null,
    validated: null,
    log,
    signal,
    warn: message => { const text = project.warn(message); emit({ event: 'warning', message: text }); return text; },
    runId: jobId,
  };

  const timings = {};
  const cancelled = () => store.get(jobId)?.state === 'cancelled';

  try {
    hydrate(context);
    // Persist what the artifacts already prove: a resumed job must leave a
    // manifest that matches the disk (progress, stage statuses), even when it
    // turns out to have nothing left to do.
    project.hydrate();
    project.save();

    let stage = project.nextStage();
    while (stage) {
      if (cancelled() || signal?.aborted) {
        log('cancelled');
        emit({ event: 'cancelled', stage });
        return store.get(jobId);
      }
      project.setRunning(stage);
      store.checkpoint(jobId, 'stage', stage);
      emit({ event: 'stage', stage, status: 'running', progress: project.progress() });

      const startedAt = Date.now();
      let result;
      try {
        const handler = engines[STAGE_HANDLERS[stage] || stage];
        if (typeof handler !== 'function') throw new Error(`The editor engine has no ${stage} stage.`);
        result = await handler(context);
      } catch (error) {
        timings[stage] = Date.now() - startedAt;
        if (cancelled() || signal?.aborted) {
          emit({ event: 'cancelled', stage });
          return store.get(jobId);
        }
        if (stage === 'mix') {
          const reason = degradeMix(project, error);
          if (reason) {
            project.setStage(stage, {
              status: 'skipped',
              artifact: 'out/mixed.mp4',
              error: String(reason).slice(0, 500),
              metrics: { durationMs: timings[stage] },
              endedAt: new Date().toISOString(),
            });
            project.warn(reason);
            store.checkpoint(jobId, 'progress', project.progress());
            store.checkpoint(jobId, 'metrics', stageMetrics(timings));
            log(`mix skipped: ${reason}`);
            emit({ event: 'stage', stage, status: 'skipped', error: reason, progress: project.progress() });
            stage = project.nextStage();
            continue;
          }
        }
        project.setFailed(stage, error);
        store.setState(jobId, 'error', { error: `${stage}: ${error.message}` });
        store.checkpoint(jobId, 'metrics', stageMetrics(timings));
        log(`${stage} failed: ${error.message}`);
        emit({ event: 'error', stage, error: error.message, progress: project.progress() });
        return store.get(jobId);
      }

      timings[stage] = Date.now() - startedAt;
      applyResult(stage, context, result);
      const artifact = artifactOf(stage, result);
      if (result?.skipped) {
        project.setStage(stage, {
          status: 'skipped',
          artifact,
          error: String(result.reason || `${stage} was skipped`).slice(0, 500),
          metrics: { durationMs: timings[stage], ...(result.metrics || {}) },
          endedAt: new Date().toISOString(),
        });
        store.checkpoint(jobId, 'progress', project.progress());
        emit({
          event: 'stage', stage, status: 'skipped', progress: project.progress(),
          reason: result.reason || null, duration_ms: timings[stage],
        });
      } else {
        project.setDone(stage, {
          artifact,
          metrics: { durationMs: timings[stage], ...(result?.metrics || {}) },
        });
        store.checkpoint(jobId, 'progress', project.progress());
        emit({
          event: 'stage', stage, status: 'done', progress: project.progress(),
          duration_ms: timings[stage],
        });
      }
      stage = project.nextStage();
    }

    // ── Finalize ────────────────────────────────────────────────────────────
    const outputs = [];
    for (const entry of JOB_OUTPUTS) {
      try {
        const file = project.artifactPath(entry.artifact);
        if (!fs.existsSync(file)) continue;
        const bytes = fs.statSync(file).size;
        outputs.push({ artifact: entry.artifact, kind: entry.kind, bytes });
        store.addArtifact(jobId, { path: file, kind: entry.kind });
      } catch { /* an artifact outside the project is not an output */ }
    }
    const metrics = {
      stages: { ...timings },
      totalMs: totalOf(timings),
      sourceDurationSeconds: context.probe?.duration ?? null,
      planDurationSeconds: context.plan?.duration ?? null,
      beats: Array.isArray(context.plan?.beats) ? context.plan.beats.length : null,
      faceShare: context.plan?.stats?.face_share ?? null,
      outputs: outputs.map(entry => ({ artifact: entry.artifact, kind: entry.kind, bytes: entry.bytes })),
    };
    store.checkpoint(jobId, 'metrics', metrics);
    store.checkpoint(jobId, 'progress', 100);
    store.checkpoint(jobId, 'outputs', outputs);
    store.setState(jobId, 'done');
    log(`edit complete (${(metrics.totalMs / 1000).toFixed(1)}s, ${outputs.length} output file(s))`);
    emit({ event: 'done', progress: 100, metrics });
    return store.get(jobId);
  } finally {
    if (store.governor) store.releaseLease(jobId);
  }
}

// ── Style analysis (examples → style profile) ───────────────────────────────

function analysisStageState(dir) {
  const state = {};
  for (const stage of EDITOR_ANALYSIS_STAGES) {
    const relative = ANALYSIS_ARTIFACTS[stage];
    const file = path.join(dir, relative);
    state[stage] = fs.existsSync(file) && fs.statSync(file).size > 0 ? 'done' : 'pending';
  }
  return state;
}

/**
 * An analysis job is not a project: its "artifacts" live directly in the analysis
 * directory (`examples/index.json`, then `style-profile.json` + `contact-sheet.jpg`).
 */
export async function runEditorAnalysisJob(store, jobId, {
  engines,
  signal = null,
  onEvent = null,
  waitForSlotMs = 10 * 60 * 1000,
} = {}) {
  if (!engines) throw new Error('runEditorAnalysisJob requires editor engines');
  const job = store.get(jobId);
  if (!job) throw new Error(`No such job: ${jobId}`);
  if (job.type !== EDITOR_ANALYSIS_JOB_TYPE) throw new Error(`Job ${jobId} is not an editor analysis job`);
  const dir = job.params?.projectDir;
  if (!dir || !fs.existsSync(dir)) throw new Error('The analysis directory for that job is missing.');
  const examples = Array.isArray(job.params?.examples) ? job.params.examples : [];
  const examplesDir = path.join(dir, 'examples');
  fs.mkdirSync(examplesDir, { recursive: true });

  const emit = payload => {
    if (typeof onEvent !== 'function') return;
    try { onEvent({ job_id: jobId, ...payload }); } catch { /* observers must not break the run */ }
  };
  const log = message => { store.log(jobId, message); emit({ event: 'log', message: String(message) }); };

  if (store.governor && !store.get(jobId).checkpoints?.leaseToken) {
    try {
      await store.admitAsync(jobId, { resourceClass: 'heavy', waitForSlotMs });
    } catch (error) {
      store.setState(jobId, 'error', { error: `Governor admission denied: ${error.message}`, admit: false });
      emit({ event: 'error', error: error.message });
      return store.get(jobId);
    }
  }
  if (store.get(jobId).state === 'queued') store.setState(jobId, 'running', { admit: false });
  if (store.get(jobId).state !== 'running') {
    emit({ event: 'error', error: store.get(jobId).error || 'job could not start' });
    return store.get(jobId);
  }

  const state = analysisStageState(dir);
  const timings = {};
  const cancelled = () => store.get(jobId)?.state === 'cancelled';
  const artifactOfStage = stage => ANALYSIS_ARTIFACTS[stage];

  const stageHandlers = {
    async download() {
      const files = [];
      let counter = 0;
      for (const example of examples) {
        signal?.throwIfAborted();
        counter += 1;
        if (example.kind === 'url') {
          const downloaded = await engines.downloadExample({ url: example.value, dir: examplesDir, signal, log });
          files.push({
            kind: 'url',
            value: example.value,
            file: path.relative(dir, downloaded.file),
            bytes: downloaded.bytes ?? null,
            duration: downloaded.duration ?? null,
          });
        } else {
          const source = path.resolve(String(example.value));
          if (!fs.existsSync(source)) throw new Error(`Example video not found: ${source}`);
          const ext = path.extname(source).toLowerCase() || '.mp4';
          const target = path.join(examplesDir, `example_${String(counter).padStart(2, '0')}${ext}`);
          if (path.resolve(target) !== source) fs.copyFileSync(source, target);
          files.push({ kind: 'file', value: source, file: path.relative(dir, target), bytes: fs.statSync(target).size, duration: null });
        }
      }
      if (!files.length) throw new Error('No example could be fetched.');
      const document = { generated_at: new Date().toISOString(), label: job.params?.label || null, examples: files };
      fs.writeFileSync(path.join(dir, ANALYSIS_ARTIFACTS.download), `${JSON.stringify(document, null, 2)}\n`);
      return { artifact: ANALYSIS_ARTIFACTS.download, files };
    },

    async analyze() {
      const indexFile = path.join(dir, ANALYSIS_ARTIFACTS.download);
      let files = [];
      if (fs.existsSync(indexFile)) {
        try {
          files = (JSON.parse(fs.readFileSync(indexFile, 'utf8')).examples || [])
            .map(entry => path.join(dir, entry.file))
            .filter(file => fs.existsSync(file));
        } catch { files = []; }
      }
      if (!files.length) {
        files = fs.readdirSync(examplesDir)
          .filter(name => !name.startsWith('.'))
          .sort()
          .map(name => path.join(examplesDir, name));
      }
      if (!files.length) throw new Error('There is no example video to analyse; run the download stage again.');
      const result = await engines.analyzeExamples({ paths: files, workDir: dir, signal, log });
      const profileFile = path.join(dir, ANALYSIS_ARTIFACTS.analyze);
      if (!fs.existsSync(profileFile)) throw new Error('The analysis produced no style-profile.json.');
      return { artifact: ANALYSIS_ARTIFACTS.analyze, profile: result.profile, contactSheet: result.contactSheet || null };
    },
  };

  try {
    for (const stage of EDITOR_ANALYSIS_STAGES) {
      if (state[stage] === 'done') {
        emit({ event: 'stage', stage, status: 'done', hydrated: true, progress: Math.round((EDITOR_ANALYSIS_STAGES.indexOf(stage) / EDITOR_ANALYSIS_STAGES.length) * 100) });
        continue;
      }
      if (cancelled() || signal?.aborted) {
        log('cancelled');
        emit({ event: 'cancelled', stage });
        return store.get(jobId);
      }
      store.checkpoint(jobId, 'stage', stage);
      emit({ event: 'stage', stage, status: 'running', label: ANALYSIS_LABELS[stage], progress: Math.round((EDITOR_ANALYSIS_STAGES.indexOf(stage) / EDITOR_ANALYSIS_STAGES.length) * 100) });
      const startedAt = Date.now();
      let result;
      try {
        result = await stageHandlers[stage]();
      } catch (error) {
        timings[stage] = Date.now() - startedAt;
        if (cancelled() || signal?.aborted) {
          emit({ event: 'cancelled', stage });
          return store.get(jobId);
        }
        store.setState(jobId, 'error', { error: `${stage}: ${error.message}` });
        store.checkpoint(jobId, 'metrics', stageMetrics(timings));
        log(`${stage} failed: ${error.message}`);
        emit({ event: 'error', stage, error: error.message });
        return store.get(jobId);
      }
      timings[stage] = Date.now() - startedAt;
      state[stage] = 'done';
      store.checkpoint(jobId, 'analysisStages', { ...state });
      store.checkpoint(jobId, 'progress', Math.round(((EDITOR_ANALYSIS_STAGES.indexOf(stage) + 1) / EDITOR_ANALYSIS_STAGES.length) * 100));
      emit({
        event: 'stage', stage, status: 'done', progress: Math.round(((EDITOR_ANALYSIS_STAGES.indexOf(stage) + 1) / EDITOR_ANALYSIS_STAGES.length) * 100),
        duration_ms: timings[stage], artifact: result?.artifact || null,
      });
    }

    const metrics = {
      stages: { ...timings },
      totalMs: totalOf(timings),
      examples: examples.length,
    };
    store.checkpoint(jobId, 'metrics', metrics);
    store.checkpoint(jobId, 'progress', 100);
    const profileFile = path.join(dir, ANALYSIS_ARTIFACTS.analyze);
    const contactSheet = path.join(dir, 'contact-sheet.jpg');
    if (fs.existsSync(profileFile)) store.addArtifact(jobId, { path: profileFile, kind: 'style_profile' });
    if (fs.existsSync(contactSheet)) store.addArtifact(jobId, { path: contactSheet, kind: 'contact_sheet' });
    store.setState(jobId, 'done');
    log(`style analysis complete (${(metrics.totalMs / 1000).toFixed(1)}s)`);
    emit({ event: 'done', progress: 100, metrics });
    return store.get(jobId);
  } finally {
    if (store.governor) store.releaseLease(jobId);
  }
}

/** Register a job for resumption (crash recovery); mirrors resumeTranslateJob. */
export function resumeEditorJob(store, jobId) {
  const job = store.get(jobId);
  if (!job || job.type !== EDITOR_JOB_TYPE) throw new Error(`No such editor job: ${jobId}`);
  if (!EditorProject.exists(job.params?.projectDir)) throw new Error('The editor project for that job is missing.');
  const project = EditorProject.load(job.params.projectDir);
  const nextStage = project.nextStage();
  return { job, project, nextStage, resumable: Boolean(nextStage) && job.state !== 'done' };
}

export { ANALYSIS_ARTIFACTS };
