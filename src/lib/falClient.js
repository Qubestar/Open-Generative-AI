// fal.ai media client for Vidmyo.
//
// Hosts open-source editing models (VACE video-to-video editing, LatentSync
// lip-sync, ProPainter inpainting, …) behind one key. Uses fal's async queue:
//   POST https://queue.fal.run/{model}        → { request_id, status_url, response_url }
//   GET  {status_url}                          → { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   GET  {response_url}                         → model output (e.g. { video: { url } })
//
// Docs: https://fal.ai/docs/documentation/model-apis/inference/queue

import { getSavedProviderKey } from './providers.js';

const FAL_QUEUE = 'https://queue.fal.run';

function getKey() {
  const key = getSavedProviderKey('fal');
  if (!key) throw new Error('fal.ai API key missing. Add it in Settings → Providers.');
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a fal model through the queue API and return its raw output object.
 * `onRequestId(id)` fires once accepted; `onTick(status)` reports progress.
 */
export async function runFalModel(model, input, { onRequestId, onTick } = {}) {
  const key = getKey();
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

  const submit = await fetch(`${FAL_QUEUE}/${model}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  if (!submit.ok) {
    const t = await submit.text();
    throw new Error(`fal submit failed: ${submit.status} — ${t.slice(0, 200)}`);
  }
  const job = await submit.json();
  const requestId = job.request_id;
  const statusUrl = job.status_url || `${FAL_QUEUE}/${model}/requests/${requestId}/status`;
  const responseUrl = job.response_url || `${FAL_QUEUE}/${model}/requests/${requestId}`;
  if (requestId && onRequestId) onRequestId(requestId);

  // Poll (video editing can take a couple of minutes).
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    let s;
    try {
      s = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
    } catch {
      continue;
    }
    if (!s.ok) continue;
    const data = await s.json();
    if (onTick) onTick(data.status);
    if (data.status === 'COMPLETED') {
      const res = await fetch(responseUrl, { headers: { Authorization: `Key ${key}` } });
      if (!res.ok) throw new Error(`fal result fetch failed: ${res.status}`);
      return res.json();
    }
    // fal does not surface a terminal "FAILED" in status; errors come back on
    // the response endpoint. IN_QUEUE / IN_PROGRESS → keep polling.
  }
  throw new Error('fal generation timed out after ~10 minutes.');
}

/**
 * Video-to-video editing via Wan VACE (add/remove/change elements of footage).
 * Returns { url, id }. fal result URLs are public CDN links, playable directly.
 */
export async function editVideo({ falModel, prompt, videoUrl, imageUrl, maskUrl, refImageUrls, hooks } = {}) {
  const input = { prompt: prompt || '' };
  if (videoUrl) input.video_url = videoUrl;
  if (maskUrl) input.mask_video_url = maskUrl;
  if (imageUrl) input.ref_image_urls = [imageUrl];
  if (Array.isArray(refImageUrls) && refImageUrls.length) input.ref_image_urls = refImageUrls;

  const out = await runFalModel(falModel || 'fal-ai/wan-vace-14b', input, hooks || {});
  const url = out?.video?.url || out?.video_url || out?.url;
  if (!url) throw new Error('fal returned no video URL.');
  return { url, id: out?.seed != null ? String(out.seed) : undefined };
}

export const falClient = { runFalModel, editVideo };
