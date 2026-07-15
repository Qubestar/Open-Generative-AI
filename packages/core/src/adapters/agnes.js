// Agnes AI adapter (image + video) for the core job runner.
//
// Verified against Agnes AI's own docs (wiki.agnes-ai.com/en/docs, fetched 2026-07-15 —
// their public quickstart/overview/model pages, not a guess):
//   base    https://apihub.agnes-ai.com/v1
//   auth    Authorization: Bearer KEY
//   image   POST /v1/images/generations  { model, prompt, size, extra_body: { response_format } }
//           -> SYNCHRONOUS: { data: [{ url, b64_json, revised_prompt }] } — no polling.
//           Docs warn `response_format` at the top level (outside extra_body) causes a 400.
//   video   POST /v1/videos  { model, prompt, width, height, num_frames, frame_rate, ... }
//           -> { id, video_id, status: 'queued' }
//   poll    GET  https://apihub.agnes-ai.com/agnesapi?video_id=<id>  (NOT under /v1 — per docs,
//           this "recommended" poll route lives at the bare host; a "legacy" /v1/videos/<id>
//           form is also documented but unused here)
//           -> { status, progress, url }  status: queued | in_progress | completed | failed
//
// ⚠ UNVERIFIED: exact valid `size` / width×height / num_frames ranges aren't documented beyond
// one example each — defaults passed in by callers are reasonable guesses, not confirmed. The
// runner surfaces errors verbatim; a live 400/422 is how we'll learn the real constraints. Key
// always explicit — core never reads key storage.

const BASE = 'https://apihub.agnes-ai.com/v1';
const POLL_BASE = 'https://apihub.agnes-ai.com';

const extFromUrl = (url) => {
  const m = String(url).split('?')[0].match(/(\.[a-z0-9]{2,5})$/i);
  return m ? m[1] : '.bin';
};

export function agnesAdapter({ key, model, kind = 'image', base = BASE, pollBase = POLL_BASE }) {
  if (!key) throw new Error('agnesAdapter requires an API key');
  if (!model) throw new Error('agnesAdapter requires a model id (e.g. agnes-image-2.0-flash)');
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const isVideo = kind === 'video';

  return {
    // Agnes rate-limits VIDEO endpoints (status queries included) to 2 allowed / 1
    // EFFECTIVE RPM on the free tier — 6/5 on the Token Plan (their tokenplan.md).
    // 60s == the free tier's effective budget exactly, so a poll shouldn't throttle
    // at all; poll() still tolerates a 429 rather than trusting that. The cost is up
    // to 60s of lag between the render finishing and us noticing.
    // TOKEN PLAN: 5 effective RPM allows 12000 here — worth changing when Luke
    // upgrades, but do NOT drop below 60s while the account is on the free tier.
    // (The generic 4s video default is ~15 RPM, ~15x over free — that produced the
    // live "429: video status query rate limit exceeded".)
    pollMs: isVideo ? 60000 : undefined,

    async submit(params, { fetchImpl }) {
      if (isVideo) {
        const res = await fetchImpl(`${base}/videos`, {
          method: 'POST', headers, body: JSON.stringify({ model, ...params }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Agnes video submit ${res.status}: ${text.slice(0, 300)}`);
        let data; try { data = JSON.parse(text); } catch { data = {}; }
        const videoId = data.video_id || data.id;
        if (!videoId) throw new Error(`Agnes video submit: no video id in response — ${text.slice(0, 300)}`);
        return { videoId };
      }

      // Image generation is synchronous — there's no separate poll step, so submit
      // does the whole call here and stashes the finished result on the handle.
      const res = await fetchImpl(`${base}/images/generations`, {
        method: 'POST', headers, body: JSON.stringify({ model, ...params }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Agnes image submit ${res.status}: ${text.slice(0, 300)}`);
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      if (!data.data?.[0]) throw new Error(`Agnes image submit: no image in response — ${text.slice(0, 300)}`);
      return { done: true, result: data };
    },

    async poll(handle, { fetchImpl, log }) {
      if (handle.done) return { status: 'done', result: handle.result };

      const res = await fetchImpl(`${pollBase}/agnesapi?video_id=${handle.videoId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const text = await res.text();
      // A throttled or hiccuping STATUS QUERY says nothing about the render — the job
      // is still running on their side. Killing the job here just orphans a video the
      // user already paid for, so keep waiting instead. (429 = "video status query
      // rate limit exceeded"; 5xx = their 500/503 "server error"/"service overloaded".)
      if (res.status === 429 || res.status >= 500) {
        log(`agnes: status query throttled (${res.status}) — still waiting`);
        return { status: 'pending' };
      }
      if (!res.ok) return { status: 'error', error: `Agnes video status ${res.status}: ${text.slice(0, 300)}` };
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      const s = String(data.status || '').toLowerCase();
      if (s === 'completed') return { status: 'done', result: data };
      if (s === 'failed') return { status: 'error', error: 'Agnes video: failed' };
      log(`agnes: ${s || 'pending'}${data.progress != null ? ` (${data.progress}%)` : ''}`);
      return { status: 'pending' };
    },

    async fetchArtifact(result, { fetchImpl }) {
      const url = isVideo ? result?.url : result?.data?.[0]?.url;
      if (!url) throw new Error('Agnes result has no media url (b64_json responses are not handled — request response_format "url")');
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Agnes media download failed: ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ext: extFromUrl(url) };
    },
  };
}
