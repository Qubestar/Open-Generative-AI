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

export const REPURPOSE_RERUNNABLE_STAGES = new Set([
  'generate_candidates',
  'rank',
  'repair_boundaries',
  'reframe',
  'render',
]);

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
      rerunnable: precedingComplete && record.state === 'completed' && REPURPOSE_RERUNNABLE_STAGES.has(id) && !live,
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

export function reviewCandidates(candidates, view = 'recommended') {
  const ranked = candidates.some(candidate => candidate.metadata?.ranking);
  return candidates.filter(candidate => view !== 'recommended' || !ranked || candidate.metadata?.ranking?.recommended)
    .sort((left, right) => {
      const a = left.metadata?.ranking;
      const b = right.metadata?.ranking;
      return Number(Boolean(b?.recommended)) - Number(Boolean(a?.recommended))
        || (a?.overall_rank ?? Infinity) - (b?.overall_rank ?? Infinity)
        || left.id.localeCompare(right.id);
    });
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

export function repurposeRenderEligibility(manifest, preparedCandidates = null) {
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
  const missing = preparedCandidates ? selected.filter(selectedCandidate => !preparedCandidates.some(candidate => candidate.id === selectedCandidate.id
    && candidate.reframeV2?.output?.state === 'completed')) : [];
  if (missing.length) {
    return { ok: false, reason: `Generate previews and run Frame vertical for ${missing.map(candidate => candidate.id.replace('clip_', '#')).join(', ')} before Finish.`, candidateIds: [] };
  }
  return { ok: true, reason: null, candidateIds: selected.map(candidate => candidate.id) };
}

export function repurposeCandidateSelectable(candidate, busy = false) {
  return !busy && candidate?.decision === 'approved';
}

export function repurposeFramingChanged(manifest, artifact, mode) {
  return manifest?.stages?.reframe?.state === 'completed'
    && mode !== (artifact?.settings?.framing_mode || 'auto_crop');
}

export function repurposeRuntimeBlockReason(readiness) {
  if (readiness?.ok === true) return null;
  if (!readiness) return 'Local setup has not been checked yet. Click Recheck local setup.';
  if (readiness.error) return `Local setup check failed: ${normalizeRepurposeError(readiness.error)}. Click Recheck local setup.`;
  const missing = [['python', 'Python'], ['engine', 'Engine'], ['ffmpeg', 'FFmpeg'], ['ffprobe', 'FFprobe']]
    .filter(([key]) => !readiness[key]?.ok).map(([, label]) => label);
  return `Local setup check failed for ${missing.join(', ') || 'the runtime'}. Open Local setup for details, then click Recheck local setup.`;
}

export async function readRepurposeReadiness(bridge) {
  try {
    const result = await bridge.readiness();
    if (!result?.ok || !result.readiness || typeof result.readiness.ok !== 'boolean') {
      return { ok: false, error: result?.error || 'The app did not return a valid runtime check' };
    }
    return result.readiness;
  } catch (error) {
    return { ok: false, error: normalizeRepurposeError(error) };
  }
}

export function repurposeReviewNextStep(manifest) {
  return deriveRepurposeStages(manifest).find(stage => stage.runnable
    && ['rank', 'repair_boundaries', 'reframe'].includes(stage.id)) || null;
}

export function bestRepurposeJob(jobs = []) {
  return [...jobs]
    .filter(job => ['queued', 'running'].includes(job.state))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}
