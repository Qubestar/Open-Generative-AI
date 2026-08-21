import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobStore, REPURPOSE_STAGES, RepurposeProject } from '../../packages/core/index.js';
import { createRepurposeMcpService } from '../lib/repurposeService.js';

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fixture() {
  const root = tempDir('vidmyo-mcp-repurpose-');
  const jobsDir = path.join(root, 'jobs');
  const source = path.join(root, 'source.mp4');
  const projectDir = path.join(root, 'project');
  fs.writeFileSync(source, 'local media');
  return { root, jobsDir, source, projectDir };
}

function completeThrough(project, lastStage) {
  for (const stage of REPURPOSE_STAGES) {
    if (stage === 'render') break;
    project.startStage(stage);
    project.completeStage(stage, { artifact: `artifacts/${stage}.json` });
    if (stage === lastStage) break;
  }
}

test('create is local, bounded, and refuses non-empty destinations', () => {
  const { jobsDir, source, projectDir } = fixture();
  const service = createRepurposeMcpService({ jobsDir });
  const created = service.create({
    projectDir, sourcePath: source, requestedClipCount: 4, contentType: 'auto',
    targetPlatforms: ['youtube_shorts'], renderDefaults: { captions: { enabled: true, style: 'clean' } },
  });
  assert.equal(created.contract_version, 1);
  assert.equal(created.source.uri, source);
  assert.equal(created.candidate_counts.total, 0);
  assert.throws(() => service.create({
    projectDir, sourcePath: source, requestedClipCount: 4, contentType: 'auto',
    targetPlatforms: ['youtube_shorts'], renderDefaults: {},
  }), /must be empty/);
  assert.throws(() => service.create({
    projectDir: 'relative', sourcePath: source, requestedClipCount: 4, contentType: 'auto',
    targetPlatforms: ['youtube_shorts'], renderDefaults: {},
  }), /absolute local path/);
});

test('analyze returns a durable job immediately, polls sanitized state, and enforces stage order', async () => {
  const { jobsDir, source, projectDir } = fixture();
  let release;
  const runJob = async (store, jobId) => {
    store.setState(jobId, 'running');
    await new Promise(resolve => { release = resolve; });
    return store.setState(jobId, 'done');
  };
  const service = createRepurposeMcpService({ jobsDir, runJob });
  RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  assert.throws(() => service.analyze({ projectDir, stage: 'transcribe' }), /next analysis stage is ingest/);
  const started = service.analyze({ projectDir, stage: 'ingest' });
  assert.match(started.job.id, /^job_/);
  assert.equal(started.stage, 'ingest');
  assert.equal(service.getJob({ jobId: started.job.id }).state, 'running');
  assert.equal(Object.hasOwn(service.getJob({ jobId: started.job.id }), 'params'), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getJob({ jobId: started.job.id }).state, 'done');
  await service.close();
});

test('persisted running analysis resumes through the same durable job id', async () => {
  const { jobsDir, source, projectDir } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  project.startStage('ingest');
  const store = new JobStore(jobsDir);
  const persisted = store.create({
    type: 'repurpose', provider: 'local-python', project: project.manifest.id,
    params: { projectDir, stage: 'ingest', options: {} },
  });
  store.setState(persisted.id, 'running');
  const service = createRepurposeMcpService({
    jobsDir,
    runJob: async (jobStore, jobId) => jobStore.setState(jobId, 'done'),
  });
  const resumed = service.analyze({ projectDir });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.job.id, persisted.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getJob({ jobId: persisted.id }).state, 'done');
});

test('a live worker owned by another surface is polled instead of launched twice', () => {
  const { jobsDir, source, projectDir } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  project.startStage('ingest');
  const store = new JobStore(jobsDir);
  const persisted = store.create({
    type: 'repurpose', provider: 'local-python', project: project.manifest.id,
    params: { projectDir, stage: 'ingest', options: {} },
  });
  store.setState(persisted.id, 'running');
  store.checkpoint(persisted.id, 'childProcess', { pid: process.pid, substep: 'ingest' });
  let launches = 0;
  const service = createRepurposeMcpService({
    jobsDir,
    runJob: async () => { launches += 1; },
  });
  const result = service.analyze({ projectDir });
  assert.equal(result.job.id, persisted.id);
  assert.equal(result.job.active, true);
  assert.equal(result.resumed, false);
  assert.equal(launches, 0);
});

test('candidate review stays explicit and is locked while project work is queued', () => {
  const { jobsDir, source, projectDir } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  const candidate = project.addCandidate({
    proposedStartSec: 2, proposedEndSec: 23,
    metadata: { title: 'A useful moment', hook: 'Listen closely' },
  });
  const service = createRepurposeMcpService({ jobsDir });
  assert.throws(() => service.setCandidateDecision({ projectDir, candidateId: candidate.id, action: 'select' }), /not approved/);
  service.setCandidateDecision({ projectDir, candidateId: candidate.id, action: 'approve' });
  const selected = service.setCandidateDecision({ projectDir, candidateId: candidate.id, action: 'select' });
  assert.equal(selected.candidate.selected, true);
  assert.equal(service.listCandidates({ projectDir, selected: true }).candidates.length, 1);
  new JobStore(jobsDir).create({
    type: 'repurpose', project: project.manifest.id,
    params: { projectDir, stage: 'ingest', options: {} },
  });
  assert.throws(() => service.setCandidateDecision({ projectDir, candidateId: candidate.id, action: 'reject' }), /queued ingest job/);
});

test('render requires completed framing and approved selection without partial unknown-id mutation', async () => {
  const { jobsDir, source, projectDir } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  project.addCandidate({ metadata: { title: 'One' } });
  project.addCandidate({ metadata: { title: 'Two' } });
  project.setCandidateDecision('clip_001', 'approved');
  const service = createRepurposeMcpService({
    jobsDir,
    runJob: async (store, jobId) => {
      store.setState(jobId, 'running');
      return store.setState(jobId, 'done');
    },
  });
  assert.throws(() => service.render({ projectDir }), /Finish analysis through reframe/);
  completeThrough(project, 'reframe');
  fs.unlinkSync(source);
  assert.throws(() => service.render({ projectDir, candidateIds: ['clip_001'] }), /source is missing/);
  assert.equal(RepurposeProject.load(projectDir).getCandidate('clip_001').selected, false);
  fs.writeFileSync(source, 'local media');
  assert.throws(() => service.render({ projectDir, candidateIds: ['clip_001', 'clip_999'] }), /Unknown candidates/);
  assert.equal(RepurposeProject.load(projectDir).getCandidate('clip_001').selected, false);
  const started = service.render({
    projectDir, candidateIds: ['clip_001'], captionsEnabled: true,
    captionStyle: 'bold', platforms: ['tiktok'],
  });
  assert.equal(started.publishing_allowed, false);
  assert.equal(started.stage, 'render');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getJob({ jobId: started.job.id }).state, 'done');
});

test('job lookup rejects other Vidmyo job types and never leaks absolute artifacts', () => {
  const { jobsDir, source, projectDir } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  const store = new JobStore(jobsDir);
  const media = store.create({ type: 'video', params: {} });
  assert.throws(() => createRepurposeMcpService({ jobsDir }).getJob({ jobId: media.id }), /No such Repurpose job/);
  const repurpose = store.create({
    type: 'repurpose', project: project.manifest.id,
    params: { projectDir, stage: 'ingest', options: {} },
  });
  store.addArtifact(repurpose.id, { path: path.join(projectDir, 'artifacts', 'safe.json'), kind: 'test' });
  store.addArtifact(repurpose.id, { path: source, kind: 'outside' });
  const result = createRepurposeMcpService({ jobsDir }).getJob({ jobId: repurpose.id });
  assert.deepEqual(result.artifacts.map(item => item.path), ['artifacts/safe.json']);
});

test('candidate artifact reads reject a project symlink that resolves outside', () => {
  const { jobsDir, source, projectDir, root } = fixture();
  const project = RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  project.addCandidate({ metadata: { title: 'Safe manifest title' } });
  const outside = path.join(root, 'outside-artifacts');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'boundary-artifact.v1.json'), JSON.stringify({
    candidates: [{
      candidate_id: 'clip_001',
      repaired_span: { start_seconds: 1, end_seconds: 20 },
      extraction: { state: 'completed', path: '../../outside.mp4' },
    }],
  }));
  fs.symlinkSync(outside, path.join(projectDir, 'artifacts'));
  const listed = createRepurposeMcpService({ jobsDir }).listCandidates({ projectDir });
  assert.equal(listed.candidates[0].preview_path, null);
  assert.equal(listed.candidates[0].repaired_start_seconds, null);
});

test('service shutdown cancels and terminates only its owned active worker', async () => {
  const { jobsDir, source, projectDir } = fixture();
  RepurposeProject.create(projectDir, { source: { type: 'local_file', uri: source } });
  let release;
  let terminated = 0;
  const service = createRepurposeMcpService({
    jobsDir,
    runJob: async (store, jobId, options) => {
      store.setState(jobId, 'running');
      await new Promise(resolve => {
        release = resolve;
        options.onChild({ kill: () => { terminated += 1; resolve(); } });
      });
      return store.get(jobId);
    },
  });
  const started = service.analyze({ projectDir });
  assert.equal(service.getJob({ jobId: started.job.id }).state, 'running');
  await service.close();
  assert.equal(terminated, 1);
  assert.equal(service.getJob({ jobId: started.job.id }).state, 'cancelled');
  release?.();
});
