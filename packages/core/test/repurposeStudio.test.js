import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  deriveRepurposeStages,
  joinRepurposeCandidates,
  mergeRepurposeProgress,
  normalizeRepurposeError,
  repurposeRenderEligibility,
} from '../../studio/src/repurposeModel.mjs';

const stageRecord = state => ({ state, artifact: state === 'completed' ? `artifacts/${state}.json` : null, error: null });
const manifest = states => ({
  stages: Object.fromEntries([
    'ingest', 'transcribe', 'generate_candidates', 'rank', 'repair_boundaries', 'reframe', 'render',
  ].map((stage, index) => [stage, stageRecord(states[index] || 'pending')])),
  candidates: [],
});

test('stage model exposes only the next dependency-safe action', () => {
  const stages = deriveRepurposeStages(manifest(['completed', 'failed']));
  assert.equal(stages[0].state, 'completed');
  assert.equal(stages[1].state, 'failed');
  assert.equal(stages[1].runnable, true);
  assert.equal(stages[2].state, 'blocked');
  assert.equal(stages[2].runnable, false);
});

test('stage model merges durable running job progress and resume state', () => {
  const project = manifest(['completed', 'running']);
  const jobs = [{
    id: 'job_1', stage: 'transcribe', state: 'running', createdAt: '2026-08-22T01:00:00Z',
    checkpoints: { progress: { fraction: 0.42, substep: 'transcribe' } },
  }];
  const stages = deriveRepurposeStages(project, jobs);
  assert.equal(stages[1].resumable, true);
  assert.equal(stages[1].progress.fraction, 0.42);
  jobs[0].active = true;
  assert.equal(deriveRepurposeStages(project, jobs)[1].resumable, false);
  const merged = mergeRepurposeProgress({}, { job_id: 'job_1', event: 'progress', payload: { fraction: 0.6 } });
  assert.equal(merged.job_1.payload.fraction, 0.6);
});

test('candidate join prefers v2 vertical media and keeps exports by stable id', () => {
  const project = manifest([]);
  project.candidates = [{
    id: 'clip_001', decision: 'approved', selected: true,
    proposed_start_sec: 4, proposed_end_sec: 29, metadata: { title: 'A clear answer' },
  }];
  const joined = joinRepurposeCandidates(project, {
    boundary: { candidates: [{ candidate_id: 'clip_001', repaired_span: { start_seconds: 5, end_seconds: 28 }, extraction: { state: 'completed', path: 'artifacts/boundary.mp4' } }] },
    reframeV1: { candidates: [{ candidate_id: 'clip_001', output: { state: 'completed', path: 'artifacts/v1.mp4' } }] },
    reframeV2: { candidates: [{ candidate_id: 'clip_001', mode: 'two_speaker_split', output: { state: 'completed', path: 'artifacts/v2.mp4' } }] },
    render: { candidates: [{ candidate_id: 'clip_001', exports: [{ preset_id: 'tiktok', output: { path: 'artifacts/final.mp4' } }] }] },
  });
  assert.equal(joined[0].preview.path, 'artifacts/v2.mp4');
  assert.equal(joined[0].durationSeconds, 23);
  assert.equal(joined[0].exports[0].preset_id, 'tiktok');
});

test('render eligibility remains explicitly manual', () => {
  const project = manifest(['completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
  project.candidates = [{ id: 'clip_001', decision: 'pending', selected: false }];
  assert.match(repurposeRenderEligibility(project).reason, /Approve and select/);
  project.candidates[0] = { id: 'clip_001', decision: 'approved', selected: true };
  assert.deepEqual(repurposeRenderEligibility(project), { ok: true, reason: null, candidateIds: ['clip_001'] });
});

test('errors are bounded and normalized for UI display', () => {
  const error = normalizeRepurposeError({ message: `broken\n${'x'.repeat(800)}` });
  assert.equal(error.includes('\n'), false);
  assert.equal(error.length, 500);
});

test('studio renders one detected-agent dropdown and locks artifact provenance', () => {
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /<span>AI agent<\/span>/);
  assert.match(source, /readiness\?\.analysis\?\.agents/);
  assert.match(source, /artifacts\.candidate\?\.provider\?\.id/);
  assert.match(source, /This project is locked to the agent that generated its candidates/);
  assert.doesNotMatch(source, /\['codex',\s*'claude_code'/);
});
