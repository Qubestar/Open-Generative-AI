export const REPURPOSE_STAGE_ORDER = [
  'ingest',
  'transcribe',
  'generate_candidates',
  'rank',
  'repair_boundaries',
  'reframe',
  'render',
];

export const REPURPOSE_STAGE_LABELS = {
  ingest: 'Inspect',
  transcribe: 'Transcribe',
  generate_candidates: 'Find moments',
  rank: 'Rank',
  repair_boundaries: 'Cut previews',
  reframe: 'Frame vertical',
  render: 'Finish',
};

const terminalJobStates = new Set(['done', 'error', 'cancelled']);

export function normalizeRepurposeError(error, fallback = 'The action could not be completed.') {
  const message = typeof error === 'string' ? error : error?.message || error?.error;
  return String(message || fallback).replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function formatRepurposeDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '—';
  const total = Math.round(Number(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function deriveRepurposeStages(manifest, jobs = []) {
  if (!manifest?.stages) return [];
  let precedingComplete = true;
  return REPURPOSE_STAGE_ORDER.map((id, index) => {
    const record = manifest.stages[id] || { state: 'pending', artifact: null, error: null };
    const job = jobs
      .filter(item => item?.stage === id)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    const live = job && !terminalJobStates.has(job.state) ? job : null;
    const state = live?.state === 'queued' ? 'queued' : live?.state === 'running' ? 'running' : record.state;
    const blocked = !precedingComplete && !['running', 'completed'].includes(state);
    const progress = live?.checkpoints?.progress || null;
    const result = {
      id,
      index,
      label: REPURPOSE_STAGE_LABELS[id],
      state: blocked ? 'blocked' : state,
      manifestState: record.state,
      artifact: record.artifact,
      error: record.error || (job?.state === 'error' ? job.error : null),
      job,
      progress,
      runnable: precedingComplete && ['pending', 'failed'].includes(record.state) && !live,
      resumable: precedingComplete && record.state === 'running' && job?.state === 'running' && !job.active,
      cancellable: Boolean(live),
    };
    precedingComplete = precedingComplete && record.state === 'completed';
    return result;
  });
}

export function mergeRepurposeProgress(current, event) {
  if (!event?.job_id) return current || {};
  return {
    ...(current || {}),
    [event.job_id]: {
      ...((current || {})[event.job_id] || {}),
      ...event,
      receivedAt: new Date().toISOString(),
    },
  };
}

function byCandidate(items = []) {
  return new Map(items.map(item => [item.candidate_id, item]));
}

export function joinRepurposeCandidates(manifest, artifacts = {}) {
  const boundaries = byCandidate(artifacts.boundary?.candidates);
  const reframeV1 = byCandidate(artifacts.reframeV1?.candidates);
  const reframeV2 = byCandidate(artifacts.reframeV2?.candidates);
  const renders = byCandidate(artifacts.render?.candidates);
  return (manifest?.candidates || []).map(candidate => {
    const boundary = boundaries.get(candidate.id) || null;
    const verticalV1 = reframeV1.get(candidate.id) || null;
    const verticalV2 = reframeV2.get(candidate.id) || null;
    const render = renders.get(candidate.id) || null;
    const preview = [
      verticalV2?.output,
      verticalV1?.output,
      boundary?.extraction,
    ].find(output => output?.state === 'completed' && output.path) || null;
    return {
      ...candidate,
      boundary,
      reframeV1: verticalV1,
      reframeV2: verticalV2,
      render,
      preview,
      exports: render?.exports || [],
      durationSeconds: boundary?.repaired_span
        ? boundary.repaired_span.end_seconds - boundary.repaired_span.start_seconds
        : (candidate.proposed_end_sec ?? 0) - (candidate.proposed_start_sec ?? 0),
    };
  });
}

export function repurposeRenderEligibility(manifest) {
  const candidates = manifest?.candidates || [];
  const selected = candidates.filter(candidate => candidate.selected);
  if (manifest?.stages?.reframe?.state !== 'completed') {
    return { ok: false, reason: 'Finish vertical framing before rendering.', candidateIds: [] };
  }
  if (!selected.length) {
    return { ok: false, reason: 'Approve and select at least one clip to render.', candidateIds: [] };
  }
  const invalid = selected.filter(candidate => candidate.decision !== 'approved');
  if (invalid.length) {
    return { ok: false, reason: 'Every selected clip must be approved.', candidateIds: [] };
  }
  return { ok: true, reason: null, candidateIds: selected.map(candidate => candidate.id) };
}

export function bestRepurposeJob(jobs = []) {
  return [...jobs]
    .filter(job => ['queued', 'running'].includes(job.state))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}
