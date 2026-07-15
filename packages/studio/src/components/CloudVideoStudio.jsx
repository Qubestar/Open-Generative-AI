import { useState, useEffect, useCallback } from 'react';

// Cloud Video studio — fal.ai or Agnes AI video models through the core job
// runner (window.media → electron/lib/mediaBridge.js, keychain key per
// provider). Async durable jobs; renders can take minutes and survive an
// app restart in ~/.vidmyo/jobs.

const C = {
  card: '#16161A', line: '#26262C', text: '#F5F1E8', dim: '#9A9AA2',
  accent: '#E8A33D', bad: '#ff6b6b',
};

// fal-ai/veo3 is verified (2026-07, live-tested). The others are curated from
// fal's current model listing but NOT live-tested here — try them and expect
// to iterate; fal ids also drift over time, hence Custom.
const VIDEO_MODELS = [
  { id: 'fal-ai/veo3', provider: 'fal', label: 'fal · Veo 3 — text-to-video with audio' },
  { id: 'bytedance/seedance-2.0/text-to-video', provider: 'fal', label: 'fal · Seedance 2.0 — cinematic, native audio (unverified — verify live)' },
  { id: 'xai/grok-imagine-video/text-to-video', provider: 'fal', label: 'fal · Grok Imagine Video (unverified — verify live)' },
  { id: 'agnes-video-v2.0', provider: 'agnes', label: 'Agnes · Video v2.0 (unverified — verify live)' },
  { id: 'custom', provider: 'fal', label: 'Custom fal endpoint…' },
];

// Agnes takes explicit width/height + frame count instead of an aspect ratio string.
const AGNES_VIDEO_SIZE = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 960, height: 960 },
};
const AGNES_FRAME_RATE = 24;

// "auto" = provider default (omit the field — this is what fal-ai/veo3 was
// live-verified against, so leaving Duration untouched can't regress it).
// The 4–15s range matches fal's Seedance 2.0 schema (confirmed field name
// and range from fal's own docs); veo3's own schema page didn't expose a
// duration field, so it's unverified there — try it and see what it accepts.
const DURATIONS = ['auto', '4', '6', '8', '10', '12', '15'];

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const btn = (primary = false, disabled = false) => ({
  padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? C.accent : 'rgba(255,255,255,0.06)',
  color: primary ? '#111' : C.text, border: primary ? 'none' : `1px solid ${C.line}`,
});

export default function CloudVideoStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.media?.isElectron;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(VIDEO_MODELS[0].id);
  const [customModel, setCustomModel] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [duration, setDuration] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);  // blob URL
  const [resultPath, setResultPath] = useState(null);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState([]);

  const loadRecent = useCallback(() => {
    if (hasBridge) window.media.recent({ type: 'video' }).then((r) => r.ok && setRecent(r.jobs));
  }, [hasBridge]);
  useEffect(loadRecent, [loadRecent]);

  const showVideo = async (p) => {
    const res = await window.media.readFile(p);
    if (!res.ok) { setError(res.error); return; }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(new Blob([res.bytes], { type: res.mime })));
    setResultPath(p);
  };

  const generate = async () => {
    const sel = VIDEO_MODELS.find((m) => m.id === model) || VIDEO_MODELS[0];
    const provider = sel.provider;
    const endpoint = model === 'custom' ? customModel.trim() : model;
    if (!prompt.trim() || !endpoint) return;
    setBusy(true); setError(null);
    const params = provider === 'agnes'
      ? {
          prompt: prompt.trim(),
          ...(AGNES_VIDEO_SIZE[aspect] || AGNES_VIDEO_SIZE['16:9']),
          frame_rate: AGNES_FRAME_RATE,
          num_frames: duration === 'auto' ? 121 : Math.round(Number(duration) * AGNES_FRAME_RATE),
        }
      : { prompt: prompt.trim(), aspect_ratio: aspect, ...(duration !== 'auto' ? { duration } : {}) };
    const res = await window.media.generate({ kind: 'video', provider, model: endpoint, params });
    setBusy(false);
    if (res.ok) { await showVideo(res.path); loadRecent(); }
    else setError(res.error);
  };

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Video</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Cloud video generation runs inside the Vidmyo desktop window (your provider keys are kept
          in the macOS keychain). Launch with “Start Vidmyo + Video Delta”.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 60px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', height: '100%' }}>
      <div>
        <h2 style={{ color: C.text, fontSize: 20, fontWeight: 900 }}>Video</h2>
        <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>
          fal.ai / Agnes AI · bring-your-own-key · renders take minutes and are billed per clip by the provider
        </div>
      </div>

      <div style={card}>
        <textarea
          rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the clip…"
          style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 11, padding: 12, fontSize: 13, lineHeight: 1.6, color: C.text, outline: 'none', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={model} onChange={(e) => setModel(e.target.value)}
                  style={{ background: '#0d0d10', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {VIDEO_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {model === 'custom' && (
            <input value={customModel} onChange={(e) => setCustomModel(e.target.value)}
                   placeholder="fal-ai/…"
                   style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text, fontFamily: 'ui-monospace, monospace', width: 260 }} />
          )}
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}
                  style={{ background: '#0d0d10', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {['16:9', '9:16', '1:1'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={duration} onChange={(e) => setDuration(e.target.value)}
                  title="Video length in seconds (Auto = provider default)"
                  style={{ background: '#0d0d10', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d === 'auto' ? 'Auto length' : `${d}s`}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button style={btn(true, busy || !prompt.trim())} disabled={busy || !prompt.trim()} onClick={generate}>
            {busy ? 'Rendering… (minutes)' : 'Generate'}
          </button>
        </div>
        {error && <div style={{ color: C.bad, fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>

      {videoUrl && (
        <div style={card}>
          <video src={videoUrl} controls style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.line}` }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ color: C.dim, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{resultPath}</span>
            <button style={btn()} onClick={() => window.media.reveal(resultPath)}>Show in Finder</button>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div style={card}>
          <div style={{ color: C.dim, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Recent</div>
          {recent.map((j) => (
            <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.line}` }}>
              <span style={{ color: C.dim, fontSize: 12, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.prompt || j.id}</span>
              {j.artifact && (
                <>
                  <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => showVideo(j.artifact)}>Play</button>
                  <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => window.media.reveal(j.artifact)}>Show</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
