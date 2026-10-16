// Job execution — drives a JobStore record through a provider adapter.
//
// Adapter contract (all async, all receive ctx = { fetchImpl, log }):
//   submit(params, ctx)        → handle   (provider-side ids/urls; JSON-safe —
//                                          it is checkpointed for resume)
//   poll(handle, ctx)          → { status: 'pending' | 'done' | 'error',
//                                  result?, error? }
//   fetchArtifact(result, ctx) → { bytes: Uint8Array, ext: '.png' | '.mp4' | … }
//
// runJob owns the store transitions, polling loop, cancellation (an external
// store.cancel(id) is honored between polls), artifact persistence, and the
// resume path: if the job already has a checkpointed handle, submit is skipped.

import fs from 'node:fs';
import path from 'node:path';

// Suggested bound for callers that want the admission queue to actually wait
// for the exclusive slot (e.g. a CLI/MCP batch runner) instead of failing
// immediately. Not the default — runJob defaults to admitWaitMs: 0 so
// existing "fail fast" callers (interactive "start now" UI actions) keep
// their current behavior unless they opt in.
export const RECOMMENDED_QUEUE_WAIT_MS = 5 * 60 * 1000;

export async function runJob(store, jobId, adapter, {
  outDir,
  pollMs = 3000,
  maxPolls = 400,
  fetchImpl = fetch,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  admitWaitMs = 0,
} = {}) {
  if (!outDir) throw new Error('runJob requires outDir for artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  let job = store.get(jobId);
  if (!job) throw new Error(`No such job: ${jobId}`);
  const ctx = { fetchImpl, log: (m) => store.log(jobId, m) };

  // Admission control via governor — admit once, then transition to running
  // with admit:false to prevent setState from calling admit() again (double-admission bug).
  // Uses the async, queued admission path: a second heavy job waits up to
  // admitWaitMs for the exclusive slot instead of failing immediately.
  if (store.governor && !job.checkpoints?.leaseToken) {
    try {
      await store.admitAsync(jobId, { waitForSlotMs: admitWaitMs });
      job = store.get(jobId);
    } catch (err) {
      store.setState(jobId, 'error', { error: `Governor admission denied: ${err.message}`, admit: false });
      throw err;
    }
  }

  try {
    if (job.state === 'queued') {
      store.setState(jobId, 'running', { admit: false });
    }

    const current = store.get(jobId);
    if (!current || current.state !== 'running') {
      throw new Error(`Job ${jobId} failed to enter running state: current state is ${current?.state} (${current?.error || 'admission failure'})`);
    }

    // Resume: reuse the provider handle if a previous run already submitted.
    let handle = current.checkpoints.handle;
    if (!handle) {
      handle = await adapter.submit(current.params, ctx);
      store.checkpoint(jobId, 'handle', handle);
      store.log(jobId, 'submitted to provider');
    } else {
      store.log(jobId, 'resuming with existing provider handle');
    }

    let result = null;
    for (let i = 0; i < maxPolls; i++) {
      // Honor external cancellation between polls.
      if (store.get(jobId).state === 'cancelled') return store.get(jobId);

      const status = await adapter.poll(handle, ctx);
      if (status.status === 'done') { result = status.result; break; }
      if (status.status === 'error') throw new Error(status.error || 'provider reported failure');
      await sleep(pollMs);
    }
    if (!result) throw new Error(`Timed out after ${maxPolls} polls`);

    const { bytes, ext } = await adapter.fetchArtifact(result, ctx);
    const artifactPath = path.join(outDir, `${jobId}${ext || ''}`);
    fs.writeFileSync(artifactPath, bytes);
    if (!fs.existsSync(artifactPath)) throw new Error('artifact missing after write');

    store.addArtifact(jobId, { path: artifactPath, kind: job.type });
    return store.setState(jobId, 'done');
  } catch (err) {
    // A cancel that raced the provider call is not an error.
    if (store.get(jobId)?.state === 'cancelled') return store.get(jobId);
    return store.setState(jobId, 'error', { error: err.message });
  } finally {
    // Ensure lease is freed upon terminal state
    if (store.governor) {
      store.releaseLease(jobId);
    }
  }
}
