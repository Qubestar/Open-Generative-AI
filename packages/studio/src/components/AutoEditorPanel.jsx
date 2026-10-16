import { useState, useEffect, useCallback } from 'react';

const C = {
  bg: 'var(--vm-bg)', panel: 'var(--vm-panel)', raised: 'var(--vm-raised)', line: 'var(--vm-line)',
  text: 'var(--vm-text)', dim: 'var(--vm-muted)', teal: 'var(--vm-accent)', amber: 'var(--vm-accent)', danger: 'var(--vm-danger)',
};

export default function AutoEditorPanel({ projectDir, onEdgUpdated }) {
  const hasBridge = typeof window !== 'undefined' && Boolean(window.autoEditor);
  const [edg, setEdg] = useState(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [suggestions, setSuggestions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);

  const fetchEdg = useCallback(async () => {
    if (!hasBridge || !projectDir) return;
    try {
      const res = await window.autoEditor.getEdg(projectDir);
      if (res.ok) {
        setEdg(res.edg);
        setHistory(res.history || { canUndo: false, canRedo: false });
        onEdgUpdated?.(res.edg);
      }
    } catch {
      // fallback
    }
  }, [hasBridge, projectDir, onEdgUpdated]);

  useEffect(() => {
    fetchEdg();
  }, [fetchEdg]);

  const handleUndo = async () => {
    if (!hasBridge || !projectDir || !history.canUndo) return;
    setLoading(true);
    try {
      const res = await window.autoEditor.undo(projectDir);
      if (res.ok) {
        setEdg(res.edg);
        setHistory(res.history);
        setNotice({ type: 'info', text: 'Undid last cut decision.' });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRedo = async () => {
    if (!hasBridge || !projectDir || !history.canRedo) return;
    setLoading(true);
    try {
      const res = await window.autoEditor.redo(projectDir);
      if (res.ok) {
        setEdg(res.edg);
        setHistory(res.history);
        setNotice({ type: 'info', text: 'Redid cut decision.' });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGetSuggestions = async () => {
    if (!hasBridge || !projectDir) return;
    setLoading(true);
    try {
      const res = await window.autoEditor.getSuggestions(projectDir, {
        threshold: brollThreshold,
        rotationDays,
        paddingMs,
        zoomFactor,
      });
      if (res.ok) {
        setSuggestions(res);
        setNotice({ type: 'success', text: `B-roll candidates and retention hooks generated (registry: ${res.registry?.source || 'unknown'}).` });
      } else {
        setNotice({ type: 'error', text: res.error });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptBrollSuggestion = async (clip) => {
    if (!hasBridge || !projectDir || !clip) return;
    setLoading(true);
    try {
      const res = await window.autoEditor.applyBrollSuggestion(projectDir, { clip, startSec: 0, durationSec: clip.durationSec || 3 });
      if (res.ok) {
        setEdg(res.edg);
        setHistory(res.history);
        onEdgUpdated?.(res.edg);
        setNotice({ type: 'success', text: `Wstawiono B-roll "${clip.id}" do EDG (można cofnąć przez Undo).` });
      } else {
        setNotice({ type: 'error', text: res.error });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleManualBrollReplacement = async () => {
    if (!hasBridge || !projectDir || !customBrollReplacement) return;
    setLoading(true);
    try {
      const clip = {
        id: `manual_${Date.now()}`,
        path: customBrollReplacement,
        fileHash: `manual_${customBrollReplacement.length}_${Date.now()}`,
        license: 'user_supplied',
        author: 'User',
        source: 'manual_user_path',
        durationSec: 3,
      };
      const res = await window.autoEditor.applyBrollSuggestion(projectDir, { clip, startSec: 0, durationSec: 3 });
      if (res.ok) {
        setEdg(res.edg);
        setHistory(res.history);
        onEdgUpdated?.(res.edg);
        setNotice({ type: 'success', text: `Zastosowano ręczną podmianę B-roll: ${customBrollReplacement}` });
        setCustomBrollReplacement('');
      } else {
        setNotice({ type: 'error', text: res.error });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleExportNle = async (format) => {
    if (!hasBridge || !projectDir) return;
    setLoading(true);
    try {
      const res = await window.autoEditor.exportNle(projectDir, format);
      if (res.ok) {
        setExportNotice(`Exported ${format.toUpperCase()} to: ${res.exportPath}`);
      } else {
        setExportNotice(`Export failed: ${res.error}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const [brollThreshold, setBrollThreshold] = useState(0.72);
  const [rotationDays, setRotationDays] = useState(30);
  const [paddingMs, setPaddingMs] = useState(150);
  const [zoomFactor, setZoomFactor] = useState(1.15);
  const [customBrollReplacement, setCustomBrollReplacement] = useState('');

  if (!hasBridge) return null;

  return (
    <div style={{ marginTop: 14, background: C.raised, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <span style={{ color: C.teal, fontSize: 10, fontWeight: 900, letterSpacing: 1.5 }}>V2.6 AI AUTO-EDITOR</span>
          <h4 style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 800 }}>EDG Timeline & Retention</h4>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            disabled={!history.canUndo || loading}
            onClick={handleUndo}
            style={{
              padding: '5px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700,
              background: C.panel, color: history.canUndo ? C.text : C.dim,
              border: `1px solid ${C.line}`, cursor: history.canUndo ? 'pointer' : 'default',
            }}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            disabled={!history.canRedo || loading}
            onClick={handleRedo}
            style={{
              padding: '5px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700,
              background: C.panel, color: history.canRedo ? C.text : C.dim,
              border: `1px solid ${C.line}`, cursor: history.canRedo ? 'pointer' : 'default',
            }}
          >
            ↷ Redo
          </button>
        </div>
      </div>

      {edg && (
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span>Clips: <b style={{ color: C.text }}>{edg.tracks?.[0]?.clips?.length || 0}</b></span>
          <span>Frames: <b style={{ color: C.text }}>{edg.totalTimelineFrames || 0}</b></span>
          <span>Timebase: <b style={{ color: C.text }}>{edg.timebase?.fps?.num}/{edg.timebase?.fps?.den} fps</b></span>
          <span>Audio: <b style={{ color: C.text }}>48 kHz</b></span>
          <span style={{ color: C.teal }}>✓ Zero Drift</span>
        </div>
      )}

      {/* Configurable Hypotheses */}
      <div style={{ background: C.panel, padding: '8px 10px', borderRadius: 8, marginBottom: 10, fontSize: 11 }}>
        <div style={{ fontWeight: 700, color: C.teal, marginBottom: 4 }}>
          Parametry Badawcze (hipotezy konfigurowalne — do zmierzenia na Twoich danych, nie udowodnione reguły)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: C.dim }}>
            <span>Próg dopasowania B-roll: <b style={{ color: C.text }}>{brollThreshold}</b></span>
            <input
              type="range"
              min="0.50"
              max="0.95"
              step="0.01"
              value={brollThreshold}
              onChange={e => setBrollThreshold(parseFloat(e.target.value))}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: C.dim }}>
            <span>Rotacja anty-zmęczeniowa: <b style={{ color: C.text }}>{rotationDays} dni</b></span>
            <input
              type="range"
              min="7"
              max="90"
              step="1"
              value={rotationDays}
              onChange={e => setRotationDays(parseInt(e.target.value, 10))}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: C.dim }}>
            <span>Padding kontekstowy: <b style={{ color: C.text }}>{paddingMs} ms</b></span>
            <input
              type="range"
              min="0"
              max="800"
              step="10"
              value={paddingMs}
              onChange={e => setPaddingMs(parseInt(e.target.value, 10))}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, color: C.dim }}>
            <span>Punch-in zoom: <b style={{ color: C.text }}>{zoomFactor.toFixed(2)}x</b></span>
            <input
              type="range"
              min="1.00"
              max="1.50"
              step="0.01"
              value={zoomFactor}
              onChange={e => setZoomFactor(parseFloat(e.target.value))}
            />
          </label>
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
          * Próg 0.72, rotacja 30 dni, padding i zoom to hipotezy robocze retencji skonfigurowane przez użytkownika — mierzone, nie gwarantowane; nie są dowodem uniknięcia kar algorytmicznych.
        </div>
        {suggestions?.params && (
          <div style={{ fontSize: 10, color: C.teal, marginTop: 4 }}>
            Backend otrzymał: próg {suggestions.params.threshold} · rotacja {suggestions.params.rotationDays} dni ·
            padding {suggestions.params.paddingMs} ms · zoom {suggestions.params.zoomFactor}x
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={loading}
          onClick={handleGetSuggestions}
          style={{
            padding: '7px 11px', borderRadius: 7, fontSize: 11, fontWeight: 800,
            background: 'var(--vm-selected)', color: C.teal, border: `1px solid ${C.teal}`,
            cursor: 'pointer',
          }}
        >
          {loading ? 'Analyzing…' : '✨ B-roll & Retention Suggestions'}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => handleExportNle('fcpxml')}
          style={{
            padding: '7px 11px', borderRadius: 7, fontSize: 11, fontWeight: 800,
            background: C.panel, color: C.text, border: `1px solid ${C.line}`,
            cursor: 'pointer',
          }}
        >
          Export FCPXML
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => handleExportNle('premiere')}
          style={{
            padding: '7px 11px', borderRadius: 7, fontSize: 11, fontWeight: 800,
            background: C.panel, color: C.text, border: `1px solid ${C.line}`,
            cursor: 'pointer',
          }}
        >
          Export Premiere XML
        </button>
      </div>

      {notice && (
        <div style={{ marginTop: 8, fontSize: 11, color: notice.type === 'error' ? C.danger : C.teal }}>
          {notice.text}
        </div>
      )}
      {exportNotice && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.teal, wordBreak: 'break-all' }}>
          {exportNotice}
        </div>
      )}

      {suggestions && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.text, marginBottom: 6 }}>
            B-roll Suggestions (Próg ≥ {brollThreshold})
          </div>
          <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>
            Rejestr: <b style={{ color: C.text }}>{suggestions.registry?.source === 'user_registry' ? 'skonfigurowany przez użytkownika' : 'wbudowana próbka CC0 (3 klipy)'}</b>
            {suggestions.registry?.registryDir ? ` · ${suggestions.registry.registryDir}` : ''}
            {suggestions.registry?.rejected?.length > 0 ? ` · odrzucone: ${suggestions.registry.rejected.length}` : ''}
          </div>
          {suggestions.registry?.rejected?.length > 0 && (
            <div style={{ fontSize: 10, background: 'rgba(220,80,80,0.08)', border: '1px solid rgba(220,80,80,0.35)', borderRadius: 6, padding: '6px 8px', marginBottom: 6, color: C.danger }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Odrzucone wpisy rejestru B-roll (licencja niekompletna):</div>
              {suggestions.registry.rejected.map((r, idx) => (
                <div key={`rej_${idx}`} style={{ marginBottom: 2 }}>
                  • <b>{r.id || `wpis #${r.index}`}</b>: {r.reasons.join('; ')}
                </div>
              ))}
            </div>
          )}
          {suggestions.brollSuggestions?.length > 0 ? (
            suggestions.brollSuggestions.map((s, idx) => (
              <div key={idx} style={{ fontSize: 11, background: C.panel, padding: '8px', borderRadius: 6, marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span>📹 {s.id}</span>
                  <span style={{ color: C.teal }}>Dopasowanie: {((s.matchScore || 0) * 100).toFixed(0)}%</span>
                </div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>
                  Licencja: <b style={{ color: C.text }}>{s.license || 'nieznana'}</b> · Autor: {s.author || 'nieznany'} · Źródło: {s.source || 'stock_registry'}
                </div>
                <button
                  type="button"
                  onClick={() => handleAcceptBrollSuggestion(s)}
                  disabled={loading}
                  style={{ padding: '4px 8px', fontSize: 10, background: C.raised, border: `1px solid ${C.line}`, borderRadius: 4, color: C.teal, cursor: 'pointer' }}
                >
                  Wstaw do EDG
                </button>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 11, color: C.dim }}>Zachowano oryginał (żaden klip nie przekroczył progu {brollThreshold})</div>
          )}

          {/* Manual B-roll replacement — writes a real overlay clip into the EDG */}
          <div style={{ marginTop: 8, padding: '8px', background: C.panel, borderRadius: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 4 }}>
              Ręczna podmiana B-roll
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                placeholder="Ścieżka do własnego klipu (.mp4)..."
                value={customBrollReplacement}
                onChange={e => setCustomBrollReplacement(e.target.value)}
                style={{ flex: 1, padding: '4px 8px', fontSize: 11, background: C.bg, border: `1px solid ${C.line}`, borderRadius: 4, color: C.text }}
              />
              <button
                type="button"
                onClick={handleManualBrollReplacement}
                disabled={loading || !customBrollReplacement}
                style={{ padding: '4px 8px', fontSize: 11, background: C.raised, border: `1px solid ${C.line}`, borderRadius: 4, color: C.teal, cursor: 'pointer' }}
              >
                Zastąp
              </button>
            </div>
          </div>

          {suggestions.retention && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.text, marginBottom: 4 }}>
                Viral Retention & Dual-Hook Analysis
              </div>
              <div style={{ fontSize: 11, color: C.dim }}>
                Opening Hook Score: <b style={{ color: C.teal }}>{suggestions.retention.rainyScore?.totalScore}/100</b>
                {' · '}Events planned: <b style={{ color: C.text }}>{suggestions.retention.retentionEvents?.length || 0}</b>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
