// Thin client for the Video Delta local engine (Python FastAPI on 127.0.0.1:7861).
// Follows the same philosophy as electron/lib/wan2gpProvider.js: the user runs the
// engine themselves (`python -m videodelta.api`); we never bundle Python or weights —
// we just talk HTTP to it, submit jobs, and poll. Video Delta is a SEPARATE product;
// all Vidmyo glue lives here in the Vidmyo repo.

const BASE = (process.env.VIDEODELTA_URL || 'http://127.0.0.1:7861').replace(/\/$/, '');

const DOWN_HINT =
  `Video Delta engine is not reachable at ${BASE}. Start it first:\n` +
  `  cd "/Volumes/My Lexar/AI Projects/Video Delta" && source .venv/bin/activate && python -m videodelta.api\n` +
  `(or set VIDEODELTA_URL to its address).`;

async function _json(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch (err) {
    if (String(err).includes('ECONNREFUSED') || String(err).includes('fetch failed')) {
      throw new Error(DOWN_HINT);
    }
    throw err;
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Video Delta ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

const videoDelta = {
  base: BASE,

  health() { return _json('/health'); },
  capabilities() { return _json('/capabilities'); },

  // Each submit returns { job_id, status }. Renders are minutes-long → always async.
  createVideo(body) { return _json('/create', { method: 'POST', body: JSON.stringify(body) }); },
  createFilm(body) { return _json('/film', { method: 'POST', body: JSON.stringify(body) }); },
  direct(body) { return _json('/direct', { method: 'POST', body: JSON.stringify(body) }); },
  reframe(body) { return _json('/reframe', { method: 'POST', body: JSON.stringify(body) }); },

  // Social autopilot: post a finished clip; check which platforms are wired up.
  publish(body) { return _json('/publish', { method: 'POST', body: JSON.stringify(body) }); },
  publishStatus() { return _json('/publish/status'); },

  // { id, kind, status: queued|running|done|error, out: <mp4 path|null>, error }
  job(id) { return _json(`/jobs/${id}`); },
};

export { videoDelta, DOWN_HINT };
