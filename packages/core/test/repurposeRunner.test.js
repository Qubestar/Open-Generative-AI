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
