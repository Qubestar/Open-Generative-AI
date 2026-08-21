import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobStore } from '../src/jobs.js';
import { REPURPOSE_STAGES, RepurposeProject } from '../src/repurpose.js';
import { inspectRepurposeRecovery, repurposeStageSubsteps } from '../src/repurposeRunner.js';

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function runningStage(stage) {
  const root = tempDir(`vidmyo-recovery-${stage}-`);
  const source = path.join(root, 'source.mp4');
  fs.writeFileSync(source, 'media');
  const project = RepurposeProject.create(path.join(root, 'project'), {
    source: { type: 'local_file', uri: source },
  });
  for (const current of REPURPOSE_STAGES) {
    project.startStage(current);
    if (current === stage) break;
    project.completeStage(current, { artifact: `artifacts/${current}.json` });
  }
  const store = new JobStore(path.join(root, 'jobs'));
  const job = store.create({
    type: 'repurpose', provider: 'local-python', project: project.manifest.id,
    params: { projectDir: project.dir, stage, options: {} },
  });
  store.setState(job.id, 'running');
  return { project, store, job };
}

test('recovery contract names every major stage and both reframe substeps', () => {
  assert.deepEqual(REPURPOSE_STAGES, [
    'ingest', 'transcribe', 'generate_candidates', 'rank',
    'repair_boundaries', 'reframe', 'render',
  ]);
  assert.deepEqual(repurposeStageSubsteps('reframe'), ['single_speaker', 'two_speaker']);
  for (const stage of REPURPOSE_STAGES.filter(item => item !== 'reframe')) {
    assert.equal(repurposeStageSubsteps(stage).length, 1);
  }
});

for (const stage of REPURPOSE_STAGES) {
  test(`stale ${stage} worker resumes the same job while preserving completed substeps`, () => {
    const { project, store, job } = runningStage(stage);
    const first = repurposeStageSubsteps(stage)[0];
    store.checkpoint(job.id, 'completedSubsteps', [first]);
    store.checkpoint(job.id, 'childProcess', { pid: 999999, substep: first });
    const result = inspectRepurposeRecovery(store, project.dir, { processAlive: () => false });
    const current = result.stages.find(item => item.stage === stage);
    assert.equal(current.action, 'resume_persisted_job');
    assert.equal(current.job_id, job.id);
    assert.deepEqual(current.reusable_substeps, [first]);
    assert.equal(current.safe_to_resume, true);
    for (const prior of result.stages.slice(0, REPURPOSE_STAGES.indexOf(stage))) {
      assert.equal(prior.action, 'preserve_completed');
    }
  });
}

test('a live child is polled, never resumed or terminated by the audit', () => {
  const { project, store, job } = runningStage('transcribe');
  store.checkpoint(job.id, 'childProcess', { pid: process.pid, substep: 'transcribe' });
  let checks = 0;
  const result = inspectRepurposeRecovery(store, project.dir, {
    processAlive: pid => { checks += 1; return pid === process.pid; },
  });
  const stage = result.stages.find(item => item.stage === 'transcribe');
  assert.equal(stage.action, 'wait_for_owned_worker');
  assert.equal(stage.safe_to_resume, false);
  assert.equal(checks, 1);
});

test('cancelled and failed work retries only its current stage; later stages stay blocked', () => {
  const { project, store, job } = runningStage('rank');
  store.cancel(job.id);
  project.failStage('rank', 'cancelled');
  const result = inspectRepurposeRecovery(store, project.dir, { processAlive: () => false });
  const rank = result.stages.find(item => item.stage === 'rank');
  assert.equal(rank.action, 'retry_preserved_stage');
  assert.match(rank.guidance, /prerequisites.*caches.*preserved/);
  assert.equal(result.stages.find(item => item.stage === 'repair_boundaries').action, 'blocked_by_prerequisite');
});
