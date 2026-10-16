'use strict';

// A boundary is shared: moving it transfers audio, never hides or duplicates it.
function moveBoundary(plan, segmentId, seconds, expectedSeconds) {
  const ordered = [...plan.decisions].sort((a, b) => a.start_seconds - b.start_seconds);
  const index = ordered.findIndex(item => item.segment_id === segmentId);
  const left = ordered[index];
  const right = ordered[index + 1];
  if (!left || !right || Math.abs(left.end_seconds - right.start_seconds) > 0.001)
    throw new Error('This join is not adjacent. Reload the review first.');
  if (!Number.isFinite(seconds) || seconds <= left.start_seconds + 0.001 || seconds >= right.end_seconds - 0.001)
    throw new Error('Choose a time inside these two sections.');
  if (!Number.isFinite(expectedSeconds) || Math.abs(left.end_seconds - expectedSeconds) > 0.001)
    throw new Error('This join changed. Reload the review before adjusting it.');
  const boundary = Math.round(seconds * 1000) / 1000;
  for (const item of [left, right]) {
    item.original_timing ??= { start_seconds: item.start_seconds, end_seconds: item.end_seconds };
    item.timing_adjusted = true;
    // A previously reviewed decision is not proof that the new audio was heard.
    item.needs_review = true;
    item.reviewed = false;
  }
  left.end_seconds = right.start_seconds = boundary;
  // Derived ranges must never survive a timing change.
  delete plan.kept_ranges;
  return plan;
}

module.exports = { moveBoundary };
