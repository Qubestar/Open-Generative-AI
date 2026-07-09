// Higgsfield Cloud API adapter (image/video) for the core job runner.
//
// Built to the OFFICIAL SDK's documented shape (@higgsfield/client v2):
//   base   https://platform.higgsfield.ai
//   auth   Authorization: Key KEY_ID:KEY_SECRET   (stored key = "id:secret")
//   submit POST /v2/<endpoint>  { params: { <input> } }  -> { id | request_id }
//   poll   GET  /v2/requests/<id>  -> { status, jobs:[{ results:{ raw:{ url }}}] }
//   status queued | in_progress | completed | failed | nsfw
//
// ⚠ VERIFY: the raw REST wire format is inferred from the SDK (which abstracts
// it) and third-party docs disagree. The runner surfaces errors verbatim; one
// live generation confirms/corrects the exact path + field names. Key always
// explicit — core never reads key storage.

const BASE = 'https://platform.higgsfield.ai';

const extFromUrl = (url) => {
  const m = String(url).split('?')[0].match(/(\.[a-z0-9]{2,5})$/i);
  return m ? m[1] : '.png';
};

function findMediaUrl(obj) {
  // Tolerate schema drift: dig for the first plausible media URL.
  const j = obj?.jobs?.[0]?.results || obj?.results || obj;
  return (
    j?.raw?.url || j?.min?.url || j?.url ||
    obj?.jobs?.[0]?.result_url || obj?.output?.url || obj?.url || null
  );
}

export function higgsfieldAdapter({ key, endpoint = 'flux-pro/kontext/max/text-to-image', base = BASE }) {
  if (!key) throw new Error('higgsfieldAdapter requires a key ("KEY_ID:KEY_SECRET")');
  const auth = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

  return {
    async submit(params, { fetchImpl }) {
      const res = await fetchImpl(`${base}/v2/${endpoint}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ params }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Higgsfield submit ${res.status}: ${text.slice(0, 300)}`);
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      const id = data.id || data.request_id || data.job_set_id || data.jobs?.[0]?.id;
      if (!id) throw new Error(`Higgsfield submit: no request id in response — ${text.slice(0, 300)}`);
      return { id };
    },

    async poll(handle, { fetchImpl, log }) {
      const res = await fetchImpl(`${base}/v2/requests/${handle.id}`, { headers: { Authorization: `Key ${key}` } });
      if (!res.ok) return { status: 'error', error: `Higgsfield status ${res.status}` };
      const data = await res.json();
      const s = String(data.status || data.state || '').toLowerCase();
      if (s === 'completed' || s === 'succeeded' || s === 'done') return { status: 'done', result: data };
      if (s === 'failed' || s === 'error' || s === 'nsfw') return { status: 'error', error: `Higgsfield: ${s}` };
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
