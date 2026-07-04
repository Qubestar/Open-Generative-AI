// fal.ai queue adapter for the core job runner.
//
// Mirrors the proven renderer flow (src/lib/falClient.js):
//   POST https://queue.fal.run/{model}  → { request_id, status_url, response_url }
//   GET  status_url                     → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
//   GET  response_url                   → model output ({ images: [{url}] } or { video: {url} })
// The key is explicit — core never reads key storage.

const FAL_QUEUE = 'https://queue.fal.run';

const extFromUrl = (url) => {
  const m = String(url).split('?')[0].match(/(\.[a-z0-9]{2,5})$/i);
  return m ? m[1] : '.bin';
};

export function falAdapter({ model, key, queueBase = FAL_QUEUE }) {
  if (!model) throw new Error('falAdapter requires a model id (e.g. fal-ai/flux/dev)');
  if (!key) throw new Error('falAdapter requires an API key');
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

  return {
    async submit(params, { fetchImpl }) {
      const res = await fetchImpl(`${queueBase}/${model}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`fal submit failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return {
        requestId: data.request_id,
        statusUrl: data.status_url,
        responseUrl: data.response_url,
      };
    },

    async poll(handle, { fetchImpl, log }) {
      const res = await fetchImpl(handle.statusUrl, { headers: { Authorization: `Key ${key}` } });
      if (!res.ok) return { status: 'error', error: `fal status failed: ${res.status}` };
      const data = await res.json();
      if (data.status === 'COMPLETED') {
        const out = await fetchImpl(handle.responseUrl, { headers: { Authorization: `Key ${key}` } });
        if (!out.ok) return { status: 'error', error: `fal response failed: ${out.status}` };
        return { status: 'done', result: await out.json() };
      }
      if (data.status === 'IN_QUEUE' || data.status === 'IN_PROGRESS') {
        log(`fal: ${data.status.toLowerCase()}`);
        return { status: 'pending' };
      }
      return { status: 'error', error: `fal: unexpected status ${data.status}` };
    },

    async fetchArtifact(result, { fetchImpl }) {
      const url = result?.images?.[0]?.url || result?.video?.url || result?.audio?.url;
      if (!url) throw new Error('fal result contains no media url');
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`fal media download failed: ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), ext: extFromUrl(url) };
    },
  };
}
