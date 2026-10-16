import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobStore } from '../src/jobs.js';
import { REPURPOSE_STAGES, RepurposeProject } from '../src/repurpose.js';
import {
  buildRepurposeSteps,
  cancelRepurposeJob,
  createRepurposeJob,
  insideRepurposeProject,
  runRepurposeJob,
} from '../src/repurposeRunner.js';

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = character => `sha256:${character.repeat(64)}`;

test('render forwards local upscale and caption studio options and rejects unknown modes', () => {
  const project = projectAt('render');
  try {
    const options = { upscale_mode: 'lanczos_4k_sharp', caption_style: 'studio_karaoke_middle_clear' };
    assert.deepEqual(buildRepurposeSteps(project, 'render', 'job_upscale', options)[0].request.options, options);
    assert.throws(() => buildRepurposeSteps(project, 'render', 'job_invalid', { upscale_mode: 'cloud_ai' }), /Upscale mode/);
  } finally {
    fs.rmSync(project.dir, { recursive: true, force: true });
  }
});

function projectAt(stage, { state = 'pending' } = {}) {
  const dir = tempDir('vidmyo-repurpose-runner-');
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'media');
  const project = RepurposeProject.create(dir, { source: { type: 'local_file', uri: source } });
  project.manifest.source.fingerprint = sha('a');
  const index = REPURPOSE_STAGES.indexOf(stage);
  for (let i = 0; i < index; i++) {
    project.manifest.stages[REPURPOSE_STAGES[i]] = {
      state: 'completed',
      artifact: `artifacts/${REPURPOSE_STAGES[i]}.json`,
      error: null,
    };
  }
  project.manifest.stages[stage] = { state, artifact: null, error: null };
  project.save();
  return project;
}

function childProcess(run) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = signal => {
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => run(child));
  return child;
}

function event(request, sequence, name, payload = {}) {
  return {
    protocol_version: 1,
    job_id: request.job_id,
    sequence,
    event: name,
    stage: request.stage,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function emitStream(child, events, { chunks = false, code = 0 } = {}) {
  const body = `${events.map(item => JSON.stringify(item)).join('\n')}\n`;
  if (chunks) {
    child.stdout.write(body.slice(0, 17));
    child.stdout.write(body.slice(17, 71));
    child.stdout.write(body.slice(71));
  } else {
    child.stdout.write(body);
  }
  child.stdout.end();
  child.stderr.end();
  queueMicrotask(() => child.emit('close', code, null));
}

function fakeSpawn(handler) {
  return (_python, args, options) => childProcess(child => {
    const requestPath = args.at(-1);
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    handler({ child, request, requestPath, command: args[2], options });
  });
}

function writeArtifact(projectDir, relativePath, artifact) {
  const file = insideRepurposeProject(projectDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(artifact));
}

function projectWithPreviews() {
  const project = projectAt('render', { state: 'completed' });
  for (let index = 0; index < 3; index++) project.addCandidate({ proposedStartSec: index * 30, proposedEndSec: index * 30 + 25 });
  project.manifest.candidates[0].metadata.ranking = { recommended: true };
  project.setCandidateDecision('clip_001', 'approved');
  project.selectCandidate('clip_001', true);
  writeArtifact(project.dir, 'artifacts/boundary-artifact.v1.json', {
    source: { fingerprint: sha('a') }, requested_candidate_ids: ['clip_001', 'clip_002'],
  });
  return project;
}

test('both reframe workers receive the explicit full-frame mode', () => {
  const project = projectAt('reframe');
  const options = { framing_mode: 'fit_full' };
  const steps = buildRepurposeSteps(project, 'reframe', 'job_full_frame', options);
  assert.equal(steps.length, 2);
  for (const step of steps) assert.deepEqual(step.request.options, options);
  assert.throws(() => buildRepurposeSteps(project, 'reframe', 'job_invalid', { framing_mode: 'stretch' }), /Framing mode/);
});

test('side-stack framing and bounded caption branding are forwarded to local workers', () => {
  const project = projectAt('reframe');
  for (const step of buildRepurposeSteps(project, 'reframe', 'job_stack', { framing_mode: 'stack_sides' })) {
    assert.equal(step.request.options.framing_mode, 'stack_sides');
  }
  const renderProject = projectAt('render');
  const options = { candidate_ids: ['clip_001'], caption_color: '#7C5CFF', caption_font: 'montserrat' };
  const [render] = buildRepurposeSteps(renderProject, 'render', 'job_brand', options);
  assert.deepEqual(render.request.options, options);
  assert.throws(() => buildRepurposeSteps(renderProject, 'render', 'job_bad_color', { caption_color: 'purple' }), /Caption color/);
  assert.throws(() => buildRepurposeSteps(renderProject, 'render', 'job_bad_font', { caption_font: '/tmp/font.ttf' }), /Caption font/);
});

test('a completed Finish stage can be explicitly rerun with new local output settings', async () => {
  const project = projectAt('render', { state: 'completed' });
  project.manifest.outputs = ['artifacts/platform-exports/old.mp4'];
  project.save();
  const store = new JobStore(tempDir('vidmyo-rerender-jobs-'));
  const job = createRepurposeJob(store, {
    projectDir: project.dir,
    stage: 'render',
    options: { candidate_ids: ['clip_001'], caption_style: 'clean_middle', captions_enabled: true, platforms: ['youtube_shorts'] },
  });
  assert.equal(job.params.rerender, true);

  const result = await runRepurposeJob(store, job.id, { spawnImpl: fakeSpawn(({ child, request }) => {
    const during = RepurposeProject.load(project.dir).manifest;
    assert.equal(during.stages.render.state, 'running');
    assert.deepEqual(during.outputs, ['artifacts/platform-exports/old.mp4']);
    const outputPath = 'artifacts/platform-exports/clip_001.clean_middle.youtube_shorts.mp4';
    writeArtifact(project.dir, outputPath, 'rendered');
    writeArtifact(project.dir, 'artifacts/render-artifact.v1.json', {
      source: { fingerprint: sha('a') },
      candidates: [{ candidate_id: 'clip_001', exports: [{ preset_id: 'youtube_shorts', output: { path: outputPath } }] }],
    });
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'render_artifact', version: 1, path: 'artifacts/render-artifact.v1.json' }),
      event(request, 3, 'completed'),
    ]);
  }) });

  assert.equal(result.state, 'done');
  const after = RepurposeProject.load(project.dir).manifest;
  assert.equal(after.stages.render.state, 'completed');
  assert.deepEqual(after.outputs, ['artifacts/platform-exports/clip_001.clean_middle.youtube_shorts.mp4']);
});

test('rerunning Find moments replaces approvals and invalidates only dependent stages', async () => {
  const project = projectAt('render', { state: 'completed' });
  project.manifest.candidates = [{
    id: 'clip_001', decision: 'approved', selected: true,
    proposed_start_sec: 1, proposed_end_sec: 20, metadata: { title: 'Old moment' },
  }];
  project.manifest.outputs = ['artifacts/platform-exports/old.mp4'];
  project.save();
  const store = new JobStore(tempDir('vidmyo-regenerate-candidates-'));
  const job = createRepurposeJob(store, {
    projectDir: project.dir,
    stage: 'generate_candidates',
    options: { provider: 'codex', model: 'configured-default:test' },
  });
  assert.equal(job.params.rerunStage, true);

  const result = await runRepurposeJob(store, job.id, { spawnImpl: fakeSpawn(({ child, request }) => {
    const during = RepurposeProject.load(project.dir).manifest;
    assert.equal(during.stages.transcribe.state, 'completed');
    assert.equal(during.stages.generate_candidates.state, 'running');
    for (const stage of ['rank', 'repair_boundaries', 'reframe', 'render']) {
      assert.equal(during.stages[stage].state, 'pending');
      assert.equal(during.stages[stage].artifact, null);
    }
    assert.equal(during.candidates[0].decision, 'approved');
    assert.deepEqual(during.outputs, ['artifacts/platform-exports/old.mp4']);
    writeArtifact(project.dir, 'artifacts/candidate-artifact.v1.json', {
      source: { fingerprint: sha('a') },
      candidates: [{
        id: 'clip_001', provider_suggestion_id: 'suggestion-new', window_id: 'window_000001',
        title: 'New moment', hook: 'New hook', summary: 'New summary', selection_reason: 'New reason',
        signal_types: ['tip'], proposed_span: { start_seconds: 40, end_seconds: 65 }, evidence_spans: [],
      }],
    });
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'candidate_artifact', version: 1, path: 'artifacts/candidate-artifact.v1.json' }),
      event(request, 3, 'completed'),
    ]);
  }) });

  assert.equal(result.state, 'done');
  const after = RepurposeProject.load(project.dir).manifest;
  assert.equal(after.stages.generate_candidates.state, 'completed');
  assert.equal(after.stages.rank.state, 'pending');
  assert.equal(after.candidates[0].metadata.title, 'New moment');
  assert.equal(after.candidates[0].decision, 'pending');
  assert.equal(after.candidates[0].selected, false);
  assert.deepEqual(after.outputs, ['artifacts/platform-exports/old.mp4']);
});

test('on-demand preview retains recommendations, earlier extras, and decisions; invalidates only downstream status', async () => {
  const project = projectWithPreviews();
  const store = new JobStore(tempDir('vidmyo-extra-preview-jobs-'));
  const before = structuredClone(project.manifest);
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } });
  assert.deepEqual(job.params.options, { candidate_ids: ['clip_001', 'clip_002', 'clip_003'] });
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.render.state, 'completed');
  const result = await runRepurposeJob(store, job.id, { spawnImpl: fakeSpawn(({ child, request }) => {
    const during = RepurposeProject.load(project.dir).manifest;
    assert.equal(during.stages.repair_boundaries.state, 'running');
    assert.equal(during.stages.reframe.state, 'pending');
    assert.equal(during.stages.render.state, 'pending');
    assert.deepEqual(during.candidates, before.candidates);
    writeArtifact(project.dir, 'artifacts/boundary-artifact.v1.json', {
      source: { fingerprint: sha('a') }, requested_candidate_ids: request.options.candidate_ids,
    });
    emitStream(child, [event(request, 1, 'accepted'), event(request, 2, 'artifact', {
      kind: 'boundary_artifact', version: 1, path: 'artifacts/boundary-artifact.v1.json',
    }), event(request, 3, 'completed')]);
  }) });
  assert.equal(result.state, 'done');
  const after = RepurposeProject.load(project.dir).manifest;
  assert.equal(after.stages.rank.state, 'completed');
  assert.equal(after.stages.repair_boundaries.state, 'completed');
  assert.equal(after.stages.reframe.state, 'pending');
  assert.deepEqual(after.candidates, before.candidates);
  const framing = buildRepurposeSteps(RepurposeProject.load(project.dir), 'reframe', 'job_frame');
  assert.equal(framing.length, 2);
});

test('preview extension rejects invalid input, stale cache, and concurrent jobs without mutation', () => {
  const project = projectWithPreviews();
  const store = new JobStore(tempDir('vidmyo-extra-preview-validation-'));
  const before = fs.readFileSync(path.join(project.dir, 'repurpose.json'), 'utf8');
  for (const options of [{ additional_candidate_ids: [] }, { additional_candidate_ids: ['clip_999'] }, { additional_candidate_ids: ['clip_003'], candidate_ids: ['clip_003'] }]) {
    assert.throws(() => createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options }));
  }
  assert.equal(fs.readFileSync(path.join(project.dir, 'repurpose.json'), 'utf8'), before);
  assert.equal(store.list().length, 0);
  writeArtifact(project.dir, 'artifacts/boundary-artifact.v1.json', { source: { fingerprint: sha('b') }, requested_candidate_ids: ['clip_001'] });
  assert.throws(() => createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } }), /stale/);
  store.create({ type: 'repurpose', params: { projectDir: project.dir, stage: 'render' } });
  assert.throws(() => createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } }), /current project job/);
  assert.equal(fs.readFileSync(path.join(project.dir, 'repurpose.json'), 'utf8'), before);
});

test('adding a preview preserves existing manual word-boundary edits', () => {
  const project = projectWithPreviews();
  const store = new JobStore(tempDir('vidmyo-extra-preview-boundaries-'));
  const override = { first_word_id: 'word_000001', last_word_id: 'word_000030' };
  writeArtifact(project.dir, 'artifacts/boundary-artifact.v1.json', {
    source: { fingerprint: sha('a') }, requested_candidate_ids: ['clip_001'],
    candidates: [{ candidate_id: 'clip_001', repair: { override_applied: true }, repaired_span: override }],
  });
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } });
  assert.deepEqual(job.params.options.boundary_overrides, { clip_001: override });
});

test('preview extension retries retain the full normalized request set', async () => {
  const project = projectWithPreviews();
  const store = new JobStore(tempDir('vidmyo-extra-preview-retry-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } });
  const failed = await runRepurposeJob(store, job.id, { spawnImpl: fakeSpawn(({ child, request }) => emitStream(child, [
    event(request, 1, 'accepted'), event(request, 2, 'error', { message: 'local encoder failure' }),
  ], { code: 1 })) });
  assert.equal(failed.state, 'error');
  const railRetry = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries' });
  assert.deepEqual(railRetry.params.options.candidate_ids, ['clip_001', 'clip_002', 'clip_003']);
  store.setState(railRetry.id, 'cancelled');
  const retry = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { additional_candidate_ids: ['clip_003'] } });
  assert.deepEqual(retry.params.options.candidate_ids, ['clip_001', 'clip_002', 'clip_003']);
});

test('normal Cut previews includes manual selections alongside recommendations', () => {
  const project = projectAt('repair_boundaries');
  for (let index = 0; index < 3; index++) project.addCandidate({ proposedStartSec: index * 30, proposedEndSec: index * 30 + 25 });
  project.manifest.candidates[0].metadata.ranking = { recommended: true };
  project.setCandidateDecision('clip_002', 'approved');
  project.selectCandidate('clip_002', true);
  const store = new JobStore(tempDir('vidmyo-selected-previews-'));
  let job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries' });
  assert.deepEqual(job.params.options.candidate_ids, ['clip_001', 'clip_002']);
  store.setState(job.id, 'cancelled');
  project.manifest.candidates[0].metadata.ranking.recommended = false;
  project.save();
  job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries' });
  assert.deepEqual(job.params.options.candidate_ids, ['clip_002']);
  store.setState(job.id, 'cancelled');
  job = createRepurposeJob(store, { projectDir: project.dir, stage: 'repair_boundaries', options: { candidate_ids: ['clip_003'] } });
  assert.deepEqual(job.params.options.candidate_ids, ['clip_003']);
});

test('request planner maps deterministic descriptors and both reframe substeps', () => {
  const project = projectAt('reframe');
  const steps = buildRepurposeSteps(project, 'reframe', 'job_plan', { candidate_ids: ['clip_001'] });
  assert.deepEqual(steps.map(step => step.command), ['reframe', 'reframe-two']);
  assert.deepEqual(steps[0].request.input_artifacts, [
    { kind: 'boundary_artifact', path: 'artifacts/boundary-artifact.v1.json', version: 1 },
  ]);
  assert.deepEqual(steps[1].request.input_artifacts, [
    { kind: 'reframe_artifact', path: 'artifacts/reframe-artifact.v1.json', version: 1 },
    { kind: 'boundary_artifact', path: 'artifacts/boundary-artifact.v1.json', version: 1 },
  ]);
  assert.notEqual(steps[0].request.job_id, steps[1].request.job_id);

  const render = projectAt('render');
  assert.deepEqual(buildRepurposeSteps(render, 'render', 'job_render')[0].request.input_artifacts, [
    { kind: 'transcript_artifact', path: 'artifacts/transcript-artifact.v1.json', version: 1 },
    { kind: 'boundary_artifact', path: 'artifacts/boundary-artifact.v1.json', version: 1 },
    { kind: 'reframe_artifact', path: 'artifacts/reframe-artifact.v1.json', version: 1 },
    { kind: 'reframe_artifact', path: 'artifacts/reframe-artifact.v2.json', version: 2 },
  ]);
  assert.throws(() => buildRepurposeSteps(render, 'render', 'job_render', { shell: '/bin/sh' }), /Unsupported render options/);
});

test('chunked JSONL completes a durable candidate job and reconciles manual-safe metadata', async () => {
  const project = projectAt('generate_candidates');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'generate_candidates' });
  const artifact = {
    source: { fingerprint: sha('a') },
    candidates: [{
      id: 'clip_001', provider_suggestion_id: 'suggestion-1', window_id: 'window_000001',
      title: 'Title', hook: 'Hook', summary: 'Summary', selection_reason: 'Payoff',
      signal_types: ['story'],
      proposed_span: { start_seconds: 1, end_seconds: 31 }, evidence_spans: [],
    }],
  };
  const seen = [];
  const spawnImpl = fakeSpawn(({ child, request }) => {
    const relativePath = 'artifacts/candidate-artifact.v1.json';
    writeArtifact(project.dir, relativePath, artifact);
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'progress', { fraction: 0.5, message: 'halfway' }),
      event(request, 3, 'artifact', { kind: 'candidate_artifact', version: 1, path: relativePath }),
      event(request, 4, 'completed', { artifacts: [{ kind: 'candidate_artifact', version: 1, path: relativePath }] }),
    ], { chunks: true });
  });
  const done = await runRepurposeJob(store, job.id, { spawnImpl, onEvent: item => seen.push(item) });
  const reopened = new JobStore(store.dir).get(job.id);
  const manifest = RepurposeProject.load(project.dir).manifest;
  assert.equal(done.state, 'done');
  assert.equal(reopened.checkpoints.lastEvent.event, 'completed');
  assert.equal(reopened.checkpoints.progress.fraction, 0.5);
  assert.equal(reopened.checkpoints.artifactEvidence['artifacts/candidate-artifact.v1.json'].fingerprint.startsWith('sha256:'), true);
  assert.equal(manifest.stages.generate_candidates.state, 'completed');
  assert.equal(manifest.candidates[0].decision, 'pending');
  assert.equal(manifest.candidates[0].metadata.hook, 'Hook');
  assert.equal(seen.at(-1).job_id, job.id);
  assert.ok(fs.existsSync(path.join(project.dir, '.vidmyo', 'requests', `${job.id}.json`)));
});

test('candidate and ranking reconciliation preserve matching manual decisions', () => {
  const project = projectAt('generate_candidates', { state: 'running' });
  project.manifest.candidates = [{
    id: 'clip_001', decision: 'approved', selected: true,
    proposed_start_sec: 0, proposed_end_sec: 1, metadata: { old: true },
  }];
  project.save();
  project.applyCandidateArtifact({
    source: { fingerprint: sha('a') },
    candidates: [{
      id: 'clip_001', provider_suggestion_id: 'same', window_id: 'window_000001',
      title: 'New', hook: 'New hook', summary: 'New summary', selection_reason: 'New reason',
      signal_types: ['tip'], proposed_span: { start_seconds: 2, end_seconds: 22 }, evidence_spans: [],
    }],
  });
  assert.equal(project.getCandidate('clip_001').decision, 'approved');
  assert.equal(project.getCandidate('clip_001').selected, true);
  project.startStage('rank');
  project.applyRankingArtifact({
    source: { fingerprint: sha('a') }, shortlist_candidate_ids: ['clip_001'],
    candidates: [{ candidate: { id: 'clip_001' }, overall_rank: 1, recommended: true }],
  });
  assert.equal(project.getCandidate('clip_001').decision, 'approved');
  assert.equal(project.getCandidate('clip_001').selected, true);
  assert.equal(project.getCandidate('clip_001').metadata.ranking.recommended, true);
});

test('render reconciliation records only existing project-owned exports', () => {
  const project = projectAt('render', { state: 'running' });
  const outputPath = path.join(project.dir, 'artifacts', 'platform-exports', 'clip_001.clean.youtube_shorts.mp4');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, 'video');
  const artifact = {
    source: { fingerprint: sha('a') },
    candidates: [{ exports: [{ output: { path: 'artifacts/platform-exports/clip_001.clean.youtube_shorts.mp4' } }] }],
  };
  project.applyRenderArtifact(artifact);
  assert.deepEqual(project.manifest.outputs, ['artifacts/platform-exports/clip_001.clean.youtube_shorts.mp4']);

  const unsafe = projectAt('render', { state: 'running' });
  assert.throws(() => unsafe.applyRenderArtifact({
    source: { fingerprint: sha('a') }, candidates: [{ exports: [{ output: { path: '../../outside.mp4' } }] }],
  }), /escapes the Repurpose project/);
  assert.equal(unsafe.manifest.stages.render.state, 'running');
});

test('invalid event order fails the job and leaves the manifest stage retryable', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const spawnImpl = fakeSpawn(({ child, request }) => emitStream(child, [
    event(request, 1, 'accepted'), event(request, 3, 'completed'),
  ]));
  const failed = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /sequence expected 2/);
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.transcribe.state, 'failed');
});

test('a persisted running job resumes with the same id from a new JobStore instance', async () => {
  const project = projectAt('transcribe', { state: 'running' });
  const firstStore = new JobStore(tempDir('vidmyo-jobs-'));
  const job = firstStore.create({
    type: 'repurpose', provider: 'local-python', project: project.manifest.id,
    params: { projectDir: project.dir, stage: 'transcribe', options: {} },
  });
  firstStore.setState(job.id, 'running');
  const reopened = new JobStore(firstStore.dir);
  const spawnImpl = fakeSpawn(({ child, request }) => {
    const relativePath = 'artifacts/transcript-artifact.v1.json';
    writeArtifact(project.dir, relativePath, {});
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'transcript_artifact', version: 1, path: relativePath }),
      event(request, 3, 'completed'),
    ]);
  });
  const done = await runRepurposeJob(reopened, job.id, { spawnImpl });
  assert.equal(done.id, job.id);
  assert.equal(done.state, 'done');
  assert.match(done.logs[0].message, /explicitly resuming/);
});

test('queued job recovers the narrow crash window after its manifest stage started', async () => {
  const project = projectAt('transcribe', { state: 'running' });
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = store.create({
    type: 'repurpose', provider: 'local-python', project: project.manifest.id,
    params: { projectDir: project.dir, stage: 'transcribe', options: {} },
  });
  const spawnImpl = fakeSpawn(({ child, request }) => {
    const relativePath = 'artifacts/transcript-artifact.v1.json';
    writeArtifact(project.dir, relativePath, {});
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'transcript_artifact', version: 1, path: relativePath }),
      event(request, 3, 'completed'),
    ]);
  });
  const done = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(done.state, 'done');
  assert.match(done.logs[0].message, /recovering queued job/);
});

test('the two reframe workers checkpoint independently and expose only reframe-v2 completion', async () => {
  const project = projectAt('reframe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'reframe' });
  const commands = [];
  const spawnImpl = fakeSpawn(({ child, request, command }) => {
    commands.push(command);
    const version = command === 'reframe' ? 1 : 2;
    const relativePath = `artifacts/reframe-artifact.v${version}.json`;
    writeArtifact(project.dir, relativePath, {});
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'reframe_artifact', version, path: relativePath }),
      event(request, 3, 'completed'),
    ]);
  });
  const done = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(done.state, 'done');
  assert.deepEqual(commands, ['reframe', 'reframe-two']);
  assert.deepEqual(done.checkpoints.completedSubsteps, ['single_speaker', 'two_speaker']);
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.reframe.artifact, 'artifacts/reframe-artifact.v2.json');
});

test('artifact path escape is rejected before manifest completion', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const spawnImpl = fakeSpawn(({ child, request }) => emitStream(child, [
    event(request, 1, 'accepted'),
    event(request, 2, 'artifact', { kind: 'transcript_artifact', version: 1, path: '../../outside.json' }),
    event(request, 3, 'completed'),
  ]));
  const failed = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /escapes project/);
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.transcribe.state, 'failed');
});

test('unexpected project-local artifacts are rejected before durable evidence is recorded', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const spawnImpl = fakeSpawn(({ child, request }) => emitStream(child, [
    event(request, 1, 'accepted'),
    event(request, 2, 'artifact', { kind: 'wrong_artifact', version: 1, path: 'source.mp4' }),
    event(request, 3, 'completed'),
  ]));
  const failed = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /unexpected artifact/);
  assert.deepEqual(failed.artifacts, []);
  assert.deepEqual(failed.checkpoints.artifactEvidence, undefined);
});

test('worker terminal errors are bounded, durable, and never advance the manifest', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const diagnostic = 'provider unavailable '.repeat(100);
  const spawnImpl = fakeSpawn(({ child, request }) => emitStream(child, [
    event(request, 1, 'accepted'),
    event(request, 2, 'error', { code: 'worker_failed', message: diagnostic }),
  ], { code: 1 }));
  const failed = await runRepurposeJob(store, job.id, { spawnImpl });
  assert.equal(failed.state, 'error');
  assert.ok(failed.error.length <= 1000);
  assert.match(failed.error, /provider unavailable/);
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.transcribe.state, 'failed');
});

test('cancellation kills only the owned child and keeps another job untouched', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const unrelated = store.create({ type: 'image', params: {} });
  let activeChild;
  const spawnImpl = fakeSpawn(({ child, request }) => {
    activeChild = child;
    child.stdout.write(`${JSON.stringify(event(request, 1, 'accepted'))}\n`);
  });
  const running = runRepurposeJob(store, job.id, { spawnImpl });
  while (!activeChild) await new Promise(resolve => setImmediate(resolve));
  cancelRepurposeJob(store, job.id, { terminate: () => activeChild.kill('SIGTERM') });
  const cancelled = await running;
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(activeChild.killed, true);
  assert.equal(store.get(unrelated.id).state, 'queued');
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.transcribe.state, 'failed');
});

test('cancellation after worker completion wins before manifest reconciliation', async () => {
  const project = projectAt('transcribe');
  const store = new JobStore(tempDir('vidmyo-jobs-'));
  const job = createRepurposeJob(store, { projectDir: project.dir, stage: 'transcribe' });
  const spawnImpl = fakeSpawn(({ child, request }) => {
    const relativePath = 'artifacts/transcript-artifact.v1.json';
    writeArtifact(project.dir, relativePath, {});
    emitStream(child, [
      event(request, 1, 'accepted'),
      event(request, 2, 'artifact', { kind: 'transcript_artifact', version: 1, path: relativePath }),
      event(request, 3, 'completed'),
    ]);
  });
  const cancelled = await runRepurposeJob(store, job.id, {
    spawnImpl,
    onEvent: eventItem => {
      if (eventItem.event === 'completed') cancelRepurposeJob(store, job.id);
    },
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(RepurposeProject.load(project.dir).manifest.stages.transcribe.state, 'failed');
});
