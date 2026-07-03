// OpenRouter media-generation client for Vidmyo.
//
// Video: async job API — POST /api/v1/videos → 202 { id, polling_url } → poll
// the polling_url until status "completed", then download unsigned_urls[0]
// (auth-protected) and hand back a blob URL the <video> element can play.
// Image: chat-completions API with image output modality.
//
// Docs: https://openrouter.ai/docs/guides/overview/multimodal/video-generation

import { getSavedProviderKey } from './providers.js';
import { apiFetch } from './apiFetch.js';

const OR_BASE = 'https://openrouter.ai/api/v1';

function getKey() {
  const key = getSavedProviderKey('openrouter');
  if (!key) throw new Error('OpenRouter API key missing. Add it in Settings → Providers.');
  return key;
}

function authHeaders(key, json = true) {
  const h = {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': 'https://vidmyo.app',
    'X-Title': 'Vidmyo',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate a video via OpenRouter. Returns { url, id } where url is a playable
 * blob: URL. `onRequestId(id)` fires as soon as the job is accepted so callers
 * can persist it for resume. `onTick(status)` reports polling progress.
 */
export async function generateVideo({ orModel, prompt, imageUrl, onRequestId, onTick } = {}) {
  const key = getKey();

  const body = { model: orModel, prompt: prompt || '' };
  if (imageUrl) {
    body.frame_images = [
      { type: 'image_url', image_url: { url: imageUrl }, frame_type: 'first_frame' },
    ];
  }

  // 1. Submit
  const submitRes = await apiFetch(`${OR_BASE}/videos`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const t = await submitRes.text();
    throw new Error(`OpenRouter video submit failed: ${submitRes.status} — ${t.slice(0, 200)}`);
  }
  const job = await submitRes.json();
  const jobId = job.id;
  const pollingUrl = job.polling_url || `${OR_BASE}/videos/${jobId}`;
  if (jobId && onRequestId) onRequestId(jobId);

  // 2. Poll (up to ~6 min)
  const maxAttempts = 120;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);
    let pollRes;
    try {
      pollRes = await apiFetch(pollingUrl, { headers: authHeaders(key, false) });
    } catch {
      continue; // transient network error — keep polling
    }
    if (!pollRes.ok) continue;
    const data = await pollRes.json();
    const status = data.status;
    if (onTick) onTick(status);

    if (status === 'completed') {
      const contentUrl = (data.unsigned_urls && data.unsigned_urls[0]) || null;
      if (!contentUrl) throw new Error('OpenRouter returned no video URL.');
      const url = await downloadAsBlobUrl(contentUrl, key);
      return { url, id: jobId };
    }
    if (status === 'failed' || status === 'error' || status === 'canceled') {
      throw new Error(`OpenRouter video generation ${status}${data.error ? ': ' + JSON.stringify(data.error).slice(0, 160) : ''}`);
    }
    // pending / processing / queued → keep polling
  }
  throw new Error('OpenRouter video generation timed out after ~6 minutes.');
}

/** Download an auth-protected video content URL and wrap it in a blob: URL. */
async function downloadAsBlobUrl(contentUrl, key) {
  const abs = contentUrl.startsWith('http') ? contentUrl : `${OR_BASE}${contentUrl.startsWith('/') ? '' : '/'}${contentUrl}`;
  const res = await apiFetch(abs, { headers: authHeaders(key, false) });
  if (!res.ok) throw new Error(`OpenRouter video download failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Generate an image via OpenRouter chat-completions (image output modality).
 * Returns { url } where url is a data: or http URL.
 */
export async function generateImage({ orModel, prompt, imageUrl } = {}) {
  const key = getKey();

  const content = [{ type: 'text', text: prompt || '' }];
  if (imageUrl) content.push({ type: 'image_url', image_url: { url: imageUrl } });

  const res = await apiFetch(`${OR_BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify({
      model: orModel,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenRouter image failed: ${res.status} — ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const imgUrl = msg?.images?.[0]?.image_url?.url || msg?.images?.[0]?.url;
  if (!imgUrl) throw new Error('OpenRouter returned no image.');
  return { url: imgUrl, id: data.id };
}

export const openrouterClient = { generateVideo, generateImage };
