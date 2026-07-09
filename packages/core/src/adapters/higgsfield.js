// Higgsfield Cloud API adapter (image/video) for the core job runner.
//
// Verified against @higgsfield/client v0.2.1 (v2 client, dist/v2/client.js) on
// 2026-07-09 — read the actual shipped JS, not the README (the README's own
// example disagrees with its own SDK's code: it shows a `JobSet`/`.isCompleted`
// wrapper the v2 `subscribe()` never constructs; it just returns the raw
// V2Response below). Ground truth:
//   base   https://platform.higgsfield.ai
//   auth   Authorization: Key KEY_ID:KEY_SECRET   (stored key = "id:secret")
//   submit POST /<endpoint>  { <input flat, NOT wrapped in "params"> }
//          -> { status, request_id, status_url, cancel_url, images?:[{url}], video?:{url} }
//   poll   GET  /requests/<request_id>/status  -> same shape as submit response
//   status queued | in_progress | completed | failed | nsfw
// (No `/v2/` path prefix — that was the bug: the old adapter posted to
// `/v2/<endpoint>` and polled `/v2/requests/<id>`, routes that don't exist on
// the real API and appear to fall through to a generic 401.)
//
// Key always explicit — core never reads key storage.

const BASE = 'https://platform.higgsfield.ai';

const extFromUrl = (url) => {
  const m = String(url).split('?')[0].match(/(\.[a-z0-9]{2,5})$/i);
  return m ? m[1] : '.png';
};

function findMediaUrl(data) {
  return data?.images?.[0]?.url || data?.video?.url || null;
}

export function higgsfieldAdapter({ key, endpoint = 'flux-pro/kontext/max/text-to-image', base = BASE }) {
  if (!key) throw new Error('higgsfieldAdapter requires a key ("KEY_ID:KEY_SECRET")');
  const auth = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  return {
    async submit(params, { fetchImpl }) {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(params),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Higgsfield submit ${res.status}: ${text.slice(0, 300)}`);
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      const id = data.request_id;
      if (!id) throw new Error(`Higgsfield submit: no request_id in response — ${text.slice(0, 300)}`);
      return { id };
    },

    async poll(handle, { fetchImpl, log }) {
      const res = await fetchImpl(`${base}/requests/${handle.id}/status`, { headers: { Authorization: `Key ${key}` } });
      const text = await res.text();
      if (!res.ok) return { status: 'error', error: `Higgsfield status ${res.status}: ${text.slice(0, 300)}` };
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      const s = String(data.status || '').toLowerCase();
      if (s === 'completed') return { status: 'done', result: data };
      if (s === 'failed' || s === 'nsfw') return { status: 'error', error: `Higgsfield: ${s}` };
      log(`higgsfield: ${s || 'pending'}`);
      return { status: 'pending' };
    },

    async fetchArtifact(result, { fetchImpl }) {
      const url = findMediaUrl(result);
      if (!url) throw new Error('Higgsfield result has no media url (schema differs — check the completed payload)');
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Higgsfield media download failed: ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ext: extFromUrl(url) };
    },
  };
}
