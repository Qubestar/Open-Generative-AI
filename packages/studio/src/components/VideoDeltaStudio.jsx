import { useState, useEffect, useRef, useCallback } from 'react';

// Video Delta studio — drives the local Video Delta engine (a separate product) via its
// HTTP API at 127.0.0.1:7861. Free, local, LTX-first generative video on a 16 GB Mac.
// The engine must be running: `python -m videodelta.api` (see mcp/README in this repo).
const API = (typeof window !== 'undefined' && window.__VIDEODELTA_URL) || 'http://127.0.0.1:7861';

const C = {
  bg: '#0B0B0D', card: '#16161A', line: '#26262C', text: '#F5F1E8', dim: '#9A9AA2',
  accent: '#E8A33D', accent2: '#7c3aed', good: '#3ECF8E', bad: '#ff6b6b',
};

// Cloud / more-models options (monetized via affiliate). Drop YOUR referral codes into
// these URLs (replace YOUR_CODE). Video Delta stays free + local; these are the paid upsell
// for when a user wants cloud speed or models we don't run locally.
const AFFILIATES = [
  { name: 'fal.ai', blurb: 'fast cloud video/image models', url: 'https://fal.ai/?ref=YOUR_CODE' },
  { name: 'Replicate', blurb: 'run any model in the cloud', url: 'https://replicate.com/?ref=YOUR_CODE' },
  { name: 'Kling', blurb: 'premium cloud video', url: 'https://klingai.com/?ref=YOUR_CODE' },
];

export default function VideoDeltaStudio() {
  const [health, setHealth] = useState('checking');   // checking | up | down
  const [mode, setMode] = useState('clip');           // clip | film
  const [motion, setMotion] = useState('ltx');        // ltx | composite
  const [prompt, setPrompt] = useState('a red fox trots across fresh snow at golden hour');
  const [duration, setDuration] = useState(3);
  const [shots, setShots] = useState(2);
  const [title, setTitle] = useState('');
  const [narrate, setNarrate] = useState('');
  const [aspect, setAspect] = useState('16:9');   // 16:9 | 9:16 | 1:1
  const [heroSource, setHeroSource] = useState('local');   // local | openai | fal | agnes
  const [job, setJob] = useState(null);               // {id,status,out,error}
  const [elapsed, setElapsed] = useState(0);
  const [resultUrl, setResultUrl] = useState(null);
  const pollRef = useRef(null);
  const t0Ref = useRef(0);

  useEffect(() => {
    fetch(`${API}/health`).then((r) => setHealth(r.ok ? 'up' : 'down')).catch(() => setHealth('down'));
    return () => clearInterval(pollRef.current);
  }, []);

  const submit = useCallback(async () => {
    setResultUrl(null);
    setJob({ status: 'submitting' });
    t0Ref.current = Date.now();
    setElapsed(0);
    try {
      // hero_source=null keeps the engine's own default (VIDEODELTA_HERO env var /
      // local chain) exactly as before. A specific source needs its key out of the
      // keychain — never hardcoded, and only fetched when actually needed.
      let heroFields = {};
      if (heroSource !== 'local') {
        if (!window.secureKeys?.isElectron) {
          throw new Error(`${heroSource} hero source needs the Vidmyo desktop window (keychain access).`);
        }
        const { ok, keys } = await window.secureKeys.getAll();
        const key = ok && keys[heroSource];
        if (!key) throw new Error(`No ${heroSource} key saved — add it in Settings first.`);
        heroFields = { hero_source: heroSource, hero_api_key: key };
      }

      let res;
      if (mode === 'film') {
        res = await fetch(`${API}/film`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brief: prompt, shots: Number(shots), duration: Number(duration) * Number(shots),
            motion, title: title || null, narrate: narrate || null, aspect, ...heroFields,
          }),
        });
      } else {
        res = await fetch(`${API}/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, motion, duration: Number(duration), aspect, ...heroFields }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `${res.status} ${res.statusText}`);
      }
      const { job_id } = await res.json();
      setJob({ id: job_id, status: 'queued' });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        setElapsed(Math.round((Date.now() - t0Ref.current) / 1000));
        try {
          const j = await (await fetch(`${API}/jobs/${job_id}`)).json();
          setJob(j);
          if (j.status === 'done') {
            clearInterval(pollRef.current);
            setResultUrl(`${API}/jobs/${job_id}/file?t=${Date.now()}`);
          } else if (j.status === 'error') {
            clearInterval(pollRef.current);
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) {
      setJob({ status: 'error', error: String(e.message || e) });
    }
  }, [mode, motion, prompt, duration, shots, title, narrate, aspect, heroSource]);

  const busy = job && ['submitting', 'queued', 'running'].includes(job.status);
  const lbl = { display: 'block', color: C.dim, fontSize: 12, margin: '14px 0 5px' };
  const inp = {
    width: '100%', background: C.bg, color: C.text, border: `1px solid ${C.line}`,
    borderRadius: 8, padding: '9px 11px', fontSize: 14, boxSizing: 'border-box',
  };
  const seg = (active) => ({
    flex: 1, padding: '8px 0', textAlign: 'center', cursor: 'pointer', fontSize: 13,
    borderRadius: 7, border: `1px solid ${active ? C.accent2 : C.line}`,
    background: active ? C.accent2 : 'transparent', color: active ? '#fff' : C.dim,
  });

  return (
    <div style={{ padding: 24, color: C.text, background: C.bg, minHeight: '100%',
                  fontFamily: "'Avenir Next','Helvetica Neue',sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontWeight: 600 }}>Video Delta</h2>
        <span style={{
          fontSize: 11, padding: '2px 8px', borderRadius: 999,
          background: health === 'up' ? 'rgba(62,207,142,.15)' : 'rgba(255,107,107,.15)',
          color: health === 'up' ? C.good : C.bad,
        }}>
          {health === 'up' ? 'engine connected' : health === 'down' ? 'engine offline' : 'checking…'}
        </span>
      </div>
      <p style={{ color: C.dim, fontSize: 13, marginTop: 0 }}>
        Free local LTX-first video, made on this machine.
        {health === 'down' && (
          <span style={{ color: C.bad }}> — start it: <code>python -m videodelta.api</code></span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Controls */}
        <div style={{ flex: '1 1 360px', maxWidth: 460, background: C.card,
                      border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={seg(mode === 'clip')} onClick={() => setMode('clip')}>Single clip</div>
            <div style={seg(mode === 'film')} onClick={() => setMode('film')}>Multi-shot film</div>
          </div>

          <label style={lbl}>{mode === 'film' ? 'Film brief' : 'What happens in the clip'}</label>
          <textarea style={{ ...inp, minHeight: 64, resize: 'vertical' }} value={prompt}
                    onChange={(e) => setPrompt(e.target.value)} />

          <label style={lbl}>Motion</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={seg(motion === 'ltx')} onClick={() => setMotion('ltx')}>
              LTX · quality (~7 min)
            </div>
            <div style={seg(motion === 'composite')} onClick={() => setMotion('composite')}>
              Composite · faster (~3–5 min)
            </div>
          </div>

          <label style={lbl}>Format</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['16:9', 'YouTube'], ['9:16', 'TikTok / Reels'], ['1:1', 'Instagram']].map(([a, who]) => (
              <div key={a} style={seg(aspect === a)} onClick={() => setAspect(a)}>
                {a} <span style={{ opacity: 0.7 }}>· {who}</span>
              </div>
            ))}
          </div>

          <label style={lbl}>Hero image source</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              ['local', 'Local (free)'],
              ['openai', 'OpenAI gpt-image'],
              ['fal', 'fal.ai'],
              ['agnes', 'Agnes AI'],
            ].map(([v, label]) => (
              <div key={v} style={{ ...seg(heroSource === v), flex: '0 1 auto', padding: '8px 12px' }}
                   onClick={() => setHeroSource(v)}>
                {label}
              </div>
            ))}
          </div>
          {heroSource !== 'local' && (
            <p style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>
              The one expensive hero frame is generated via your {heroSource} key (Settings) —
              everything after that stays local and free.
            </p>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>{mode === 'film' ? 'Seconds / shot' : 'Duration (s)'}</label>
              <input style={inp} type="number" min={1} max={8} step={0.5} value={duration}
                     onChange={(e) => setDuration(e.target.value)} />
            </div>
            {mode === 'film' && (
              <div style={{ flex: 1 }}>
                <label style={lbl}>Shots</label>
                <input style={inp} type="number" min={1} max={6} value={shots}
                       onChange={(e) => setShots(e.target.value)} />
              </div>
            )}
          </div>

          {mode === 'film' && (
            <>
              <label style={lbl}>Title card (optional)</label>
              <input style={inp} value={title} placeholder="Winter Fox"
                     onChange={(e) => setTitle(e.target.value)} />
              <label style={lbl}>Narration (optional — adds voice + captions)</label>
              <input style={inp} value={narrate} placeholder="In the heart of winter…"
                     onChange={(e) => setNarrate(e.target.value)} />
            </>
          )}

          <button onClick={submit} disabled={busy || health !== 'up'}
                  style={{ width: '100%', marginTop: 18, padding: '12px 0', border: 'none',
                           borderRadius: 9, fontSize: 15, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
                           background: busy || health !== 'up' ? C.line : C.accent,
                           color: busy || health !== 'up' ? C.dim : '#1a1205' }}>
            {busy ? `Rendering… ${elapsed}s` : mode === 'film' ? 'Create film' : 'Create clip'}
          </button>
          {motion === 'ltx' && (
            <p style={{ color: C.dim, fontSize: 11, marginTop: 8 }}>
              Tip: keep LTX shots ~2–3s for best resolution; use more shots for more screen time.
            </p>
          )}
        </div>

        {/* Result — height-bounded so the video + its controls always fit on screen */}
        <div style={{ flex: '1 1 380px', minWidth: 300, maxWidth: 620 }}>
          <div style={{ width: '100%', height: 'min(62vh, 560px)', background: C.card,
                        border: `1px solid ${C.line}`, borderRadius: 14, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                        padding: 8, boxSizing: 'border-box' }}>
            {resultUrl ? (
              <video key={resultUrl} src={resultUrl} controls autoPlay loop playsInline
                     style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                              borderRadius: 8 }} />
            ) : (
              <div style={{ color: C.dim, fontSize: 13, textAlign: 'center', padding: 24 }}>
                {job?.status === 'error'
                  ? <span style={{ color: C.bad }}>Error: {job.error}</span>
                  : busy
                    ? `${job.status}…  ${elapsed}s elapsed`
                    : 'Your video appears here.'}
              </div>
            )}
          </div>
          {resultUrl && (
            <a href={resultUrl} download style={{ display: 'inline-block', marginTop: 10,
                 color: C.accent, fontSize: 13, textDecoration: 'none' }}>↓ Download MP4</a>
          )}
        </div>
      </div>

      {/* Cloud upsell (affiliate) — subtle, non-blocking. Video Delta itself is free + local. */}
      <div style={{ marginTop: 28, paddingTop: 16, borderTop: `1px solid ${C.line}`,
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
        <span style={{ color: C.dim, fontSize: 12 }}>Want cloud speed or more models?</span>
        {AFFILIATES.map((a) => (
          <a key={a.name} href={a.url} target="_blank" rel="noopener noreferrer"
             title={a.blurb}
             style={{ color: C.text, fontSize: 12, textDecoration: 'none',
                      border: `1px solid ${C.line}`, borderRadius: 7, padding: '5px 10px' }}>
            {a.name} <span style={{ color: C.dim }}>· {a.blurb}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
