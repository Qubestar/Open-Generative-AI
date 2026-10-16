import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { moveBoundary } = createRequire(import.meta.url)('../../../electron/lib/cleanerTiming.js');
const fixture = () => ({ kept_ranges: [[28.666,31.267]], decisions: [
  { segment_id: 'segment_000007', start_seconds: 26.666, end_seconds: 28.666, decision: 'cut', reviewed: true },
  { segment_id: 'segment_000008', start_seconds: 28.666, end_seconds: 31.267, decision: 'keep', reviewed: true },
] });
test('moving a repeated-take join transfers audio with no gap and invalidates stale ranges', () => {
  const plan = fixture();
  moveBoundary(plan, 'segment_000007', 28.9, 28.666);
  assert.equal(plan.decisions[0].end_seconds, 28.9);
  assert.equal(plan.decisions[1].start_seconds, 28.9);
  assert.deepEqual(plan.decisions.map(d => d.decision), ['cut','keep']);
  assert.equal(plan.kept_ranges, undefined);
  assert.ok(plan.decisions.every(d => d.needs_review && !d.reviewed));
  assert.equal(plan.decisions[0].original_timing.end_seconds, 28.666);
  moveBoundary(plan, 'segment_000007', 28.666, 28.9);
  assert.equal(plan.decisions[0].end_seconds, plan.decisions[1].start_seconds);
  assert.equal(plan.decisions[0].original_timing.end_seconds, 28.666);
});
test('invalid, stale, terminal and non-adjacent joins cannot mutate a plan', () => {
  for (const time of [NaN, Infinity, '28.9', 26.666, 31.267]) {
    const plan = fixture(), before = structuredClone(plan);
    assert.throws(() => moveBoundary(plan, 'segment_000007', time, 28.666));
    assert.deepEqual(plan, before);
  }
  assert.throws(() => moveBoundary(fixture(), 'segment_000007', 29, 28));
  assert.throws(() => moveBoundary(fixture(), 'segment_000008', 29, 31.267));
  const plan = fixture(); plan.decisions[1].start_seconds = 29;
  assert.throws(() => moveBoundary(plan, 'segment_000007', 29, 28.666));
});
