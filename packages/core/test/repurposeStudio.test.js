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
  reviewCandidates,
  repurposeCandidateSelectable,
  repurposeFramingChanged,
  readRepurposeReadiness,
  repurposeRuntimeBlockReason,
  repurposeReviewNextStep,
} from '../../studio/src/repurposeModel.mjs';

const stageRecord = state => ({ state, artifact: state === 'completed' ? `artifacts/${state}.json` : null, error: null });
const manifest = states => ({
  stages: Object.fromEntries([
    'ingest', 'transcribe', 'generate_candidates', 'rank', 'repair_boundaries', 'reframe', 'render',
  ].map((stage, index) => [stage, stageRecord(states[index] || 'pending')])),
  candidates: [],
});

test('approved regenerated clips are selectable without previews, but not while busy', () => {
  assert.equal(repurposeCandidateSelectable({ decision: 'approved', selected: false }), true);
  assert.equal(repurposeCandidateSelectable({ decision: 'approved' }, true), false);
  assert.equal(repurposeCandidateSelectable({ decision: 'pending' }), false);
  assert.equal(repurposeCandidateSelectable({ decision: 'rejected' }), false);
  const project = manifest(Array(3).fill('completed'));
  project.candidates = [{ id: 'clip_001', decision: 'approved', selected: true }];
  assert.equal(repurposeRenderEligibility(project).ok, false);
});

test('regeneration points to Rank, then Cut previews, then Frame vertical', () => {
  assert.equal(repurposeReviewNextStep(manifest(Array(3).fill('completed'))).id, 'rank');
  assert.equal(repurposeReviewNextStep(manifest(Array(4).fill('completed'))).id, 'repair_boundaries');
  assert.equal(repurposeReviewNextStep(manifest(Array(5).fill('completed'))).id, 'reframe');
  assert.equal(repurposeReviewNextStep(manifest(Array(6).fill('completed'))), null);
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /Recommended — awaiting Rank/);
  assert.match(source, /Rank candidates/);
  assert.match(source, /disabled=\{!repurposeCandidateSelectable\(candidate, disabled\)\}/);
  assert.doesNotMatch(source, /\(!candidate\.preview && !candidate\.selected\)/);
});

test('recommended view is ranked first without discarding or mutating other ideas', () => {
  const candidates = [
    { id: 'clip_001', metadata: { ranking: { overall_rank: 3, recommended: false } } },
    { id: 'clip_002', metadata: { ranking: { overall_rank: 2, recommended: true } } },
    { id: 'clip_003', metadata: { ranking: { overall_rank: 1, recommended: true } } },
  ];
  assert.deepEqual(reviewCandidates(candidates).map(item => item.id), ['clip_003', 'clip_002']);
  assert.deepEqual(reviewCandidates(candidates, 'all').map(item => item.id), ['clip_003', 'clip_002', 'clip_001']);
  assert.equal(candidates[0].id, 'clip_001');
  assert.deepEqual(reviewCandidates([{ id: 'clip_001' }]), [{ id: 'clip_001' }]);
  assert.deepEqual(reviewCandidates([candidates[0]]), []);
});

test('selected candidates need their own vertical output before Finish', () => {
  const project = manifest(Array(6).fill('completed'));
  project.candidates = [{ id: 'clip_001', decision: 'approved', selected: true }];
  assert.equal(repurposeRenderEligibility(project, [{ id: 'clip_001' }]).ok, false);
  assert.equal(repurposeRenderEligibility(project, [{ id: 'clip_001', reframeV2: { output: { state: 'completed' } } }]).ok, true);
});

test('changing framing requires a new vertical preview before Finish', () => {
  const project = manifest(Array(6).fill('completed'));
  assert.equal(repurposeFramingChanged(project, {}, 'auto_crop'), false); // Existing projects.
  assert.equal(repurposeFramingChanged(project, {}, 'fit_full'), true);
  const fitted = { settings: { framing_mode: 'fit_full' } };
  assert.equal(repurposeFramingChanged(project, fitted, 'fit_full'), false);
  assert.equal(repurposeFramingChanged(project, fitted, 'auto_crop'), true);
  assert.equal(repurposeFramingChanged(manifest(Array(5).fill('completed')), fitted, 'auto_crop'), false);
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /Fit full frame · black bars/);
  assert.match(source, /Stack left \+ right/);
  assert.match(source, /stage === 'reframe' \? \{ framing_mode: framingSettings.mode \}/);
  assert.match(source, /Framing changed\. Run Frame vertical again before Finish\./);
});

test('stage launch rechecks runtime instead of blocking on the startup snapshot', () => {
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /const currentReadiness = await checkRuntime\(\)/);
  assert.match(source, /launchBlockReason\(stage, currentReadiness\)/);
  assert.doesNotMatch(source, /blockReason \? explainBlock\(stage.id, blockReason\) : runStage\(stage.id\)/);
  assert.match(source, /Recheck local setup/);
});

test('a fresh readiness request recovers from a failed startup check', async () => {
  const healthy = { ok: true, python: { ok: true }, engine: { ok: true }, ffmpeg: { ok: true }, ffprobe: { ok: true } };
  let calls = 0;
  const bridge = { readiness: async () => ({ ok: true, readiness: ++calls === 1
    ? { ...healthy, ok: false, ffprobe: { ok: false, error: 'Timed out' } } : healthy }) };
  const stale = await readRepurposeReadiness(bridge);
  assert.match(repurposeRuntimeBlockReason(stale), /FFprobe/);
  assert.equal(repurposeRuntimeBlockReason(await readRepurposeReadiness(bridge)), null);
  assert.equal(calls, 2);
});

test('failed and malformed readiness responses remain blocked with useful errors', async () => {
  for (const bridge of [
    { readiness: async () => { throw new Error('Probe unavailable'); } },
    { readiness: async () => ({ ok: false, error: 'Probe unavailable' }) },
    { readiness: async () => ({ ok: true, readiness: {} }) },
  ]) {
    const result = await readRepurposeReadiness(bridge);
    assert.equal(result.ok, false);
    assert.match(repurposeRuntimeBlockReason(result), /Recheck local setup/);
  }
  assert.match(repurposeRuntimeBlockReason(null), /not been checked/);
  assert.equal(repurposeRuntimeBlockReason({ ok: true, model: { ok: false } }), null);
});

test('stage model exposes only the next dependency-safe action', () => {
  const stages = deriveRepurposeStages(manifest(['completed', 'failed']));
  assert.equal(stages[0].state, 'completed');
  assert.equal(stages[1].state, 'failed');
  assert.equal(stages[1].runnable, true);
  assert.equal(stages[2].state, 'blocked');
  assert.equal(stages[2].runnable, false);
});

test('completed editorial stages can run again without reopening source setup', () => {
  const stages = deriveRepurposeStages(manifest(Array(7).fill('completed')));
  assert.deepEqual(stages.map(stage => stage.rerunnable), [false, false, true, true, true, true, true]);
  assert.equal(stages[2].label, 'Find moments');
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

test('blocked runnable stages explain setup instead of becoming dead controls', () => {
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /stage.runnable\s*\? runStage\(stage.id\)/);
  assert.doesNotMatch(source, /stage\.runnable && Boolean\(blockReason\)/);
  assert.match(source, /if \(reason\) \{ setReadinessOpen\(true\); throw new Error\(reason\); \}/);
  assert.match(source, /Resolved model:/);
  assert.match(source, /Model folder or cache root/);
  assert.match(source, /transcriptionModel/);
});

test('finish defaults to one clip file and exposes caption style and position controls', () => {
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /targetPlatforms: \['youtube_shorts'\]/);
  assert.match(source, /One universal MP4/);
  assert.match(source, /Separate platform files/);
  assert.match(source, /Caption position/);
  assert.match(source, /captionVariant\(renderSettings\)/);
  assert.match(source, /finishedCandidates\.map/);
});

test('studio can leave a project and confirms completed-stage regeneration', () => {
  const source = fs.readFileSync(path.resolve('..', 'studio', 'src', 'components', 'RepurposeStudio.jsx'), 'utf8');
  assert.match(source, /setSummary\(null\)/);
  assert.match(source, /New project<\/button>/);
  assert.match(source, /Open another<\/button>/);
  assert.match(source, /stage\.rerunnable \? rerunStage\(stage\.id\)/);
  assert.match(source, /Run \$\{label\} again\?/);
  assert.match(source, /This replaces the current candidates and clears their approvals/);
});
