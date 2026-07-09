import { useState, useEffect, useCallback } from 'react';

// Cloud Image studio — fal.ai through the core job runner in the Electron
// main process (window.media → electron/lib/mediaBridge.js). Your fal key
// lives in the macOS keychain (Settings). Every generation is a durable job
// in ~/.vidmyo/jobs with its artifact in ~/.vidmyo/artifacts.

const C = {
  card: '#16161A', line: '#26262C', text: '#F5F1E8', dim: '#9A9AA2',
  accent: '#E8A33D', good: '#3ECF8E', bad: '#ff6b6b',
};

// Curated, verified fal endpoints (2026-07). fal ids drift — the Custom
// option accepts any endpoint id from fal.ai/explore/models.
// Each option carries its provider so the bridge picks the right key + adapter.
const IMAGE_MODELS = [
  { id: 'fal-ai/flux/schnell', provider: 'fal', label: 'fal · FLUX.1 schnell — fast & cheap' },
  { id: 'fal-ai/flux/dev', provider: 'fal', label: 'fal · FLUX.1 dev — higher quality' },
  { id: 'flux-pro/kontext/max/text-to-image', provider: 'higgsfield', label: 'Higgsfield · Flux Pro Kontext Max (beta — verify)' },
  { id: 'custom', provider: 'fal', label: 'Custom fal endpoint…' },
];

const ASPECTS = [
  ['landscape_16_9', '16:9'], ['portrait_16_9', '9:16'],
  ['square_hd', '1:1'], ['landscape_4_3', '4:3'], ['portrait_4_3', '3:4'],
];

// fal's image_size preset → a plain W:H ratio (Higgsfield's aspect_ratio).
const aspectToRatio = (a) => (ASPECTS.find(([v]) => v === a)?.[1] || '16:9');

const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
const btn = (primary = false, disabled = false) => ({
  padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
  background: primary ? C.accent : 'rgba(255,255,255,0.06)',
  color: primary ? '#111' : C.text, border: primary ? 'none' : `1px solid ${C.line}`,
});

export default function CloudImageStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.media?.isElectron;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(IMAGE_MODELS[0].id);
  const [customModel, setCustomModel] = useState('');
  const [aspect, setAspect] = useState('landscape_16_9');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // {dataUrl, path}
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState([]);

  const loadRecent = useCallback(() => {
    if (hasBridge) window.media.recent({ type: 'image' }).then((r) => r.ok && setRecent(r.jobs));
  }, [hasBridge]);
  useEffect(loadRecent, [loadRecent]);

  const generate = async () => {
    const sel = IMAGE_MODELS.find((m) => m.id === model) || IMAGE_MODELS[0];
    const provider = sel.provider;
    const endpoint = model === 'custom' ? customModel.trim() : model;
    if (!prompt.trim() || !endpoint) return;
    setBusy(true); setError(null); setResult(null);
    // Higgsfield uses aspect_ratio (e.g. "9:16"); fal uses image_size presets.
    const params = provider === 'higgsfield'
      ? { prompt: prompt.trim(), aspect_ratio: aspectToRatio(aspect), safety_tolerance: 2 }
      : { prompt: prompt.trim(), image_size: aspect };
    const res = await window.media.generate({ kind: 'image', provider, model: endpoint, params });
    setBusy(false);
    if (res.ok) { setResult(res); loadRecent(); }
    else setError(res.error);
  };

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Image</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Cloud image generation runs inside the Vidmyo desktop window (your fal.ai key is kept in
          the macOS keychain). Launch with “Start Vidmyo + Video Delta”.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 60px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', height: '100%' }}>
      <div>
        <h2 style={{ color: C.text, fontSize: 20, fontWeight: 900 }}>Image</h2>
        <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>fal.ai · bring-your-own-key · saved to ~/.vidmyo/artifacts</div>
      </div>

      <div style={card}>
        <textarea
          rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image…"
          style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 11, padding: 12, fontSize: 13, lineHeight: 1.6, color: C.text, outline: 'none', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={model} onChange={(e) => setModel(e.target.value)}
                  style={{ background: '#0d0d10', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {model === 'custom' && (
            <input value={customModel} onChange={(e) => setCustomModel(e.target.value)}
                   placeholder="fal-ai/…"
                   style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text, fontFamily: 'ui-monospace, monospace', width: 260 }} />
          )}
          <select value={aspect} onChange={(e) => setAspect(e.target.value)}
                  style={{ background: '#0d0d10', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {ASPECTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button style={btn(true, busy || !prompt.trim())} disabled={busy || !prompt.trim()} onClick={generate}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {error && <div style={{ color: C.bad, fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>

      {result && (
        <div style={card}>
          <img src={result.dataUrl} alt="result"
               style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.line}` }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ color: C.dim, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{result.path}</span>
            <button style={btn()} onClick={() => window.media.reveal(result.path)}>Show in Finder</button>
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
                <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => window.media.reveal(j.artifact)}>Show</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
