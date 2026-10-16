'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BACKGROUND_CHOICES, CONSENT_NOTICE, QUALITY_CHOICES, STAGE_LABELS,
  defaultTranslateForm, formatBytes, formatDuration, historyRow, jobPhase, jobTitle,
  languageOptions, languagePairLabel, outputLabel, preferredBackgroundMode, progressPercent,
  stageChecklist, translateFormError, translateInputFromForm, translateOptionWarnings,
  translateOptionsFromForm,
} from '../translateModel.mjs';

const C = {
  panel: 'var(--vm-panel)', raised: 'var(--vm-raised)', line: 'var(--vm-line)',
  text: 'var(--vm-text)', dim: 'var(--vm-muted)', accent: 'var(--vm-accent)',
  primary: 'var(--vm-primary)', onPrimary: 'var(--vm-on-primary)',
  danger: 'var(--vm-danger)', good: 'var(--vm-good)', warning: 'var(--vm-warning)',
  input: 'var(--vm-input)', selected: 'var(--vm-selected)',
};

const STAGE_GLYPH_COLOR = {
  done: 'var(--vm-good)', running: 'var(--vm-accent)', failed: 'var(--vm-danger)',
  skipped: 'var(--vm-muted)', pending: 'var(--vm-muted)',
};

function Label({ children, hint }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.4, textTransform: 'uppercase', color: C.dim }}>{children}</span>
      {hint && <span style={{ fontSize: 11, color: C.dim, marginLeft: 8, letterSpacing: 0 }}>{hint}</span>}
    </div>
  );
}

function Section({ title, children, note }) {
  return (
    <section style={{ borderTop: `1px solid ${C.line}`, padding: '18px 0' }}>
      <h3 style={{ color: C.text, fontSize: 14, fontWeight: 850, margin: '0 0 12px' }}>{title}</h3>
      {children}
      {note && <p style={{ color: C.dim, fontSize: 11, lineHeight: 1.5, margin: '10px 0 0' }}>{note}</p>}
    </section>
  );
}

function Check({ checked, onChange, label, detail, disabled = false }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)}
        style={{ marginTop: 2, width: 16, height: 16, accentColor: C.accent }} />
      <span>
        <span style={{ display: 'block', color: C.text, fontSize: 13, fontWeight: 700 }}>{label}</span>
        {detail && <span style={{ display: 'block', color: C.dim, fontSize: 11, marginTop: 2, lineHeight: 1.45 }}>{detail}</span>}
      </span>
    </label>
  );
}

const selectStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.input, color: C.text, fontSize: 13 };
const buttonStyle = (variant = 'ghost', disabled = false) => ({
  padding: variant === 'primary' ? '13px 20px' : '10px 14px',
  borderRadius: 9,
  border: `1px solid ${variant === 'primary' ? C.primary : C.line}`,
  background: variant === 'primary' ? C.primary : C.raised,
  color: variant === 'primary' ? C.onPrimary : C.text,
  fontWeight: 800,
  fontSize: variant === 'primary' ? 13 : 12,
  letterSpacing: variant === 'primary' ? 1.2 : 0,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});
const linkStyle = { display: 'inline-block', padding: '10px 14px', borderRadius: 9, border: `1px solid ${C.line}`, background: C.raised, color: C.text, fontWeight: 700, fontSize: 12, textDecoration: 'none' };

export default function TranslateStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.translate?.isElectron;
  const [form, setForm] = useState(defaultTranslateForm);
  const [capabilities, setCapabilities] = useState(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [voiceProfiles, setVoiceProfiles] = useState(null);
  const [config, setConfig] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [mediaUrl, setMediaUrl] = useState(null);
  const [subtitleText, setSubtitleText] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const mediaRef = useRef(null);

  const update = useCallback(patch => setForm(current => ({ ...current, ...patch })), []);

  // ── Load capabilities + settings + history ────────────────────────────────
  useEffect(() => {
    if (!hasBridge) return;
    let cancelled = false;
    (async () => {
      const caps = await window.translate.capabilities();
      if (cancelled) return;
      if (caps?.ok) setCapabilities(caps.capabilities);
      else setCapabilityError(caps?.error || 'Could not read translate capabilities.');
      const cfg = await window.translate.getConfig();
      if (!cancelled && cfg?.ok) {
        setConfig(cfg.config || {});
        setForm(current => ({
          ...current,
          voice_id: cfg.config?.voiceId || null,
          // Saved preference wins; otherwise start from what this machine does best.
          background_mode: cfg.config?.backgroundMode || preferredBackgroundMode(caps?.capabilities),
        }));
      }
      const list = await window.translate.listJobs({ limit: 25 });
      if (!cancelled && list?.ok) setHistory(list.jobs || []);
      const profiles = await window.translate.voiceProfiles();
      if (!cancelled) setVoiceProfiles(profiles?.ok ? profiles : null);
    })();
    return () => { cancelled = true; };
  }, [hasBridge]);

  // ── Subscribe to job progress ─────────────────────────────────────────────
  useEffect(() => {
    if (!hasBridge) return undefined;
    return window.translate.onProgress(event => {
      setJob(current => (current && current.job_id === event.job_id ? { ...current, state: event.state, stage: event.stage, progress: event.progress, error: event.error ?? current.error, stages: current.stages.map(entry => (entry.id === event.stage ? { ...entry, status: event.stage_status || entry.status } : entry)) } : current));
      if (['done', 'error', 'cancelled'].includes(event.state)) refreshJob(event.job_id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasBridge]);

  const refreshJob = useCallback(async jobId => {
    if (!hasBridge || !jobId) return null;
    const result = await window.translate.getJob(jobId);
    if (result?.ok && result.job) {
      setJob(result.job);
      if (result.job.state === 'done') setHistory(current => [result.job, ...current.filter(item => item.job_id !== result.job.job_id)].slice(0, 25));
      return result.job;
    }
    return null;
  }, [hasBridge]);

  // Poll while a job is active so stage transitions show even if an event is missed.
  const activeJobId = job?.job_id || null;
  const activeState = job?.state || null;
  useEffect(() => {
    if (!hasBridge || !activeJobId) return undefined;
    if (!['queued', 'running'].includes(activeState)) return undefined;
    const timer = setInterval(() => { refreshJob(activeJobId); }, 2000);
    return () => clearInterval(timer);
  }, [hasBridge, activeJobId, activeState, refreshJob]);

  // ── Preview the finished video + subtitles ────────────────────────────────
  // Keyed on the artifact names, not the job object, so a progress tick never
  // re-reads the files.
  const previewJobId = job?.state === 'done' ? (job.job_id || null) : null;
  const videoArtifact = (job?.outputs || []).find(output => output.kind === 'translated_video')?.artifact || null;
  const subtitleArtifact = (job?.outputs || []).find(output => output.kind === 'translated_subtitles')?.artifact || null;
  useEffect(() => {
    if (!hasBridge || !previewJobId) return undefined;
    let revoked = null;
    (async () => {
      if (videoArtifact) {
        const bytes = await window.translate.readMedia(previewJobId, videoArtifact);
        if (bytes?.ok) {
          const blob = new Blob([bytes.bytes], { type: bytes.mime || 'video/mp4' });
          revoked = URL.createObjectURL(blob);
          setMediaUrl(revoked);
        }
      }
      if (subtitleArtifact) {
        const text = await window.translate.readMedia(previewJobId, subtitleArtifact);
        if (text?.ok) setSubtitleText(new TextDecoder().decode(text.bytes).slice(0, 20000));
      }
    })();
    return () => { if (revoked) URL.revokeObjectURL(revoked); setMediaUrl(null); setSubtitleText(''); };
  }, [hasBridge, previewJobId, videoArtifact, subtitleArtifact]);

  const pickSource = useCallback(async () => {
    if (!hasBridge) return;
    const result = await window.translate.pickSource();
    if (result?.ok && result.path) {
      update({ inputPath: result.path, url: '' });
      setNotice({ kind: 'info', text: `Selected ${result.path}` });
    }
  }, [hasBridge, update]);

  const handleDrop = useCallback(event => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    // Electron hides the real path; the file picker is the path-authorizing route.
    setNotice({ kind: 'info', text: `Dropped ${file.name}. Use “Upload / Select Video” so Vidmyo can read it from disk.` });
  }, []);

  const formError = useMemo(() => translateFormError(form, capabilities), [form, capabilities]);
  const warnings = useMemo(() => translateOptionWarnings(form, capabilities), [form, capabilities]);
  const phase = jobPhase(job);
  const running = phase === 'running';

  const start = useCallback(async () => {
    if (!hasBridge || formError) return;
    setBusy(true);
    setNotice(null);
    setSubtitleText('');
    setMediaUrl(null);
    try {
      const payload = { input: translateInputFromForm(form), options: translateOptionsFromForm(form) };
      const result = await window.translate.start(payload);
      if (result?.ok) {
        setJob(result.job);
        setHistory(current => [result.job, ...current].slice(0, 25));
      } else {
        setNotice({ kind: 'error', text: result?.error || 'Could not start the translation.' });
      }
    } finally {
      setBusy(false);
    }
  }, [hasBridge, form, formError]);

  const cancel = useCallback(async () => {
    if (!job?.job_id) return;
    const result = await window.translate.cancelJob(job.job_id);
    if (result?.ok) setJob(result.job);
  }, [job?.job_id]);

  const retry = useCallback(async () => {
    if (!job?.job_id) return;
    const result = await window.translate.retryJob(job.job_id);
    if (result?.ok) setJob(result.job);
    else setNotice({ kind: 'error', text: result?.error || 'Could not retry that job.' });
  }, [job?.job_id]);

  const loadJob = useCallback(async row => {
    await refreshJob(row.id);
  }, [refreshJob]);

  const downloadArtifact = useCallback(async (artifact, filename) => {
    if (!job?.job_id) return;
    const result = await window.translate.readMedia(job.job_id, artifact);
    if (!result?.ok) { setNotice({ kind: 'error', text: result?.error || 'That output could not be read.' }); return; }
    const blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, [job?.job_id]);

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '28px 20px', color: C.text }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: 0 }}>Translate Video</h2>
        <p style={{ color: C.dim, fontSize: 13, lineHeight: 1.6, marginTop: 12 }}>
          Local video dubbing runs inside the Vidmyo desktop app, where it can use the local speech models,
          the local translation model and FFmpeg. Open the desktop app to translate a video, or use the
          <code style={{ margin: '0 6px', padding: '2px 6px', borderRadius: 5, background: C.raised }}>translate_video</code>
          MCP tool to run the same job from an agent.
        </p>
      </div>
    );
  }

  const checklist = stageChecklist(job);
  const percent = progressPercent(job);
  const outputs = job?.outputs || [];
  const videoOutput = outputs.find(output => output.kind === 'translated_video');
  const subtitleOutput = outputs.find(output => output.kind === 'translated_subtitles');
  const sourceOptions = languageOptions(capabilities, 'source');
  const targetOptions = languageOptions(capabilities, 'target');
  const profiles = voiceProfiles?.voices || [];

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 18px 60px', color: C.text }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: 0, letterSpacing: 0.4 }}>Translate Video</h2>
        <span style={{ fontSize: 11, color: C.dim }}>
          Local dubbing · nothing is uploaded to an AI service
        </span>
      </header>

      {capabilityError && (
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.warning}`, background: C.raised, fontSize: 12 }}>
          {capabilityError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 22, marginTop: 10 }}>
        {/* ── Form ───────────────────────────────────────────────────────── */}
        <div onDragOver={event => { event.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)} onDrop={handleDrop}
          style={{ padding: 18, borderRadius: 14, border: `1px solid ${dragActive ? C.accent : C.line}`, background: C.panel }}>
          <Section title="Video">
            <Label hint="YouTube, Vimeo, direct links or a local file">Paste a video link</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <input value={form.url} inputMode="url" placeholder="https://…"
                onChange={event => update({ url: event.target.value, inputPath: null })}
                style={{ ...selectStyle, flex: '1 1 240px' }} />
              <button type="button" disabled={!form.url.trim()} onClick={() => update({ inputPath: null })} style={buttonStyle('ghost', !form.url.trim())}>
                Import
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 14 }}>
              <button type="button" onClick={pickSource} style={buttonStyle('ghost')}>Upload / Select Video</button>
              <span style={{ fontSize: 12, color: C.dim, overflowWrap: 'anywhere' }}>
                {form.inputPath ? form.inputPath : 'or drop an MP4 / MOV here'}
              </span>
            </div>
          </Section>

          <Section title="Languages">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
              <div>
                <Label>Source language</Label>
                <select value={form.source_language} onChange={event => update({ source_language: event.target.value })} style={selectStyle}>
                  {sourceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <Label>Target language</Label>
                <select value={form.target_language} onChange={event => update({ target_language: event.target.value })} style={selectStyle}>
                  {targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </div>
          </Section>

          <Section title="Audio">
            <Check checked={form.translate_audio} onChange={value => update({ translate_audio: value })}
              label="Translate speech" detail="Generate a spoken dub in the target language." />
            <Check checked={form.clone_voice} onChange={value => update({ clone_voice: value })} disabled={!form.translate_audio}
              label="Preserve original speaker voice"
              detail={profiles.length ? 'Use a local voice profile (Voicebox / Chatterbox).' : 'Needs a local voice profile; the standard voice is used otherwise.'} />
            {form.clone_voice && form.translate_audio && profiles.length > 0 && (
              <div style={{ margin: '2px 0 12px 26px' }}>
                <select value={form.voice_id || ''} onChange={event => update({ voice_id: event.target.value || null })} style={selectStyle}>
                  <option value="">Standard local voice (no cloning)</option>
                  {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </div>
            )}
            <p style={{ margin: '0 0 14px 26px', fontSize: 11, color: C.warning }}>{CONSENT_NOTICE}</p>
            <Check checked={form.preserve_background} onChange={value => update({ preserve_background: value, background_mode: value ? (form.background_mode === 'replace' ? 'duck' : form.background_mode) : 'replace' })}
              label="Preserve music / background" detail="Keep the original score, ambience and sound effects." />
            <div style={{ marginLeft: 26 }}>
              <Label>Background handling</Label>
              <select value={form.background_mode} disabled={!form.preserve_background}
                onChange={event => update({ background_mode: event.target.value, preserve_background: event.target.value !== 'replace' })}
                style={{ ...selectStyle, opacity: form.preserve_background ? 1 : 0.5 }}>
                {BACKGROUND_CHOICES.map(choice => <option key={choice.id} value={choice.id}>{choice.label} — {choice.detail}</option>)}
              </select>
              {!capabilities?.modes?.source_separation && (
                <p style={{ fontSize: 11, color: C.dim, margin: '6px 0 0' }}>
                  Source separation is not installed here; “Duck the original” is the working default.
                </p>
              )}
            </div>
          </Section>

          <Section title="Subtitles">
            <Check checked={form.subtitles} onChange={value => update({ subtitles: value })} label="Generate translated subtitles" detail="Saved as a UTF-8 SRT beside the video." />
            <Check checked={form.burn_subtitles} onChange={value => update({ burn_subtitles: value })} disabled={!form.subtitles}
              label="Burn subtitles into video" detail="Hard-coded captions inside social safe areas." />
          </Section>

          <Section title="Lip sync">
            <Check checked={form.lip_sync} onChange={value => update({ lip_sync: value })} disabled={!form.translate_audio}
              label="Lip sync — experimental"
              detail={capabilities?.modes?.lip_sync ? 'Experimental: the job still finishes without it if it fails.' : 'No local lip-sync backend is configured; the job finishes without it.'} />
          </Section>

          <Section title="Quality">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              {QUALITY_CHOICES.map(choice => (
                <button key={choice.id} type="button" aria-pressed={form.quality === choice.id} onClick={() => update({ quality: choice.id })}
                  style={{ ...buttonStyle('ghost', false), textAlign: 'left', padding: '12px 14px', borderColor: form.quality === choice.id ? C.accent : C.line, background: form.quality === choice.id ? C.selected : C.raised }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: 13 }}>{choice.label}</span>
                  <span style={{ display: 'block', color: C.dim, fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>{choice.detail}</span>
                </button>
              ))}
            </div>
          </Section>

          {warnings.length > 0 && (
            <ul style={{ margin: '0 0 14px', padding: '10px 12px 10px 26px', borderRadius: 9, border: `1px solid ${C.line}`, background: C.raised, fontSize: 11.5, color: C.dim, lineHeight: 1.6 }}>
              {warnings.map(text => <li key={text}>{text}</li>)}
            </ul>
          )}

          {formError && <p style={{ margin: '0 0 12px', fontSize: 12, color: C.warning }}>{formError}</p>}
          {notice && (
            <p style={{ margin: '0 0 12px', fontSize: 12, color: notice.kind === 'error' ? C.danger : C.dim, overflowWrap: 'anywhere' }}>{notice.text}</p>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button type="button" onClick={start} disabled={Boolean(formError) || busy || running} style={buttonStyle('primary', Boolean(formError) || busy || running)}>
              {running ? 'TRANSLATING…' : 'TRANSLATE VIDEO'}
            </button>
            {running && <button type="button" onClick={cancel} style={buttonStyle('ghost')}>Cancel</button>}
            {phase === 'failed' && job?.retryable && <button type="button" onClick={retry} style={buttonStyle('ghost')}>Retry from the failed stage</button>}
          </div>
        </div>

        {/* ── Progress / result ──────────────────────────────────────────── */}
        {job && (
          <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${C.line}`, background: C.panel }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 850 }}>
                {phase === 'complete' ? 'Translation complete' : phase === 'failed' ? 'Translation failed' : phase === 'cancelled' ? 'Translation cancelled' : 'Translating video'}
              </h3>
              <span style={{ fontSize: 12, color: C.dim }}>{languagePairLabel(job)} · {percent}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: C.raised, margin: '12px 0 16px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${percent}%`, background: C.accent, transition: 'width 320ms ease' }} />
            </div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {checklist.map(entry => (
                <li key={entry.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', fontSize: 12.5 }}>
                  <span aria-hidden="true" style={{ color: STAGE_GLYPH_COLOR[entry.status] || C.dim, width: 14, fontFamily: 'ui-monospace, monospace' }}>{entry.glyph}</span>
                  <span style={{ color: entry.status === 'pending' ? C.dim : C.text, fontWeight: entry.status === 'running' ? 800 : 600 }}>
                    {entry.label || STAGE_LABELS[entry.id]}
                  </span>
                  {entry.error && <span style={{ color: C.dim, fontSize: 11 }}>· {entry.error}</span>}
                </li>
              ))}
            </ul>

            {job.error && <p style={{ margin: '14px 0 0', fontSize: 12, color: C.danger }}>{job.error}</p>}
            {job.warnings?.length > 0 && (
              <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 11.5, color: C.dim, lineHeight: 1.6 }}>
                {job.warnings.map(text => <li key={text}>{text}</li>)}
              </ul>
            )}
            {job.total_ms ? (
              <p style={{ margin: '12px 0 0', fontSize: 11, color: C.dim }}>
                Finished in {formatDuration(job.total_ms)} · source {job.input?.label || job.input?.uri || 'video'}
              </p>
            ) : null}

            {phase === 'complete' && (
              <div style={{ marginTop: 16 }}>
                {mediaUrl && (
                  <video src={mediaUrl} controls playsInline style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.line}`, background: '#000' }} />
                )}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                  {videoOutput && (
                    <button type="button" onClick={() => downloadArtifact(videoOutput.artifact, videoOutput.artifact.split('/').pop())} style={buttonStyle('ghost')}>
                      Download video ({formatBytes(videoOutput.bytes)})
                    </button>
                  )}
                  {subtitleOutput && (
                    <button type="button" onClick={() => downloadArtifact(subtitleOutput.artifact, subtitleOutput.artifact.split('/').pop())} style={buttonStyle('ghost')}>
                      Download subtitles
                    </button>
                  )}
                  <button type="button" onClick={() => window.translate.reveal(job.job_id, videoOutput?.artifact || null)} style={buttonStyle('ghost')}>Open folder</button>
                </div>
                {subtitleText && (
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, color: C.dim }}>Translated subtitles preview</summary>
                    <pre style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', padding: 12, borderRadius: 9, background: C.raised, border: `1px solid ${C.line}`, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{subtitleText}</pre>
                  </details>
                )}
                {outputs.length > 0 && (
                  <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 11.5, color: C.dim, lineHeight: 1.7 }}>
                    {outputs.map(output => (
                      <li key={output.artifact}>{outputLabel(output)} · {output.artifact} {output.bytes ? `· ${formatBytes(output.bytes)}` : ''}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── History ───────────────────────────────────────────────────── */}
        <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${C.line}`, background: C.panel }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 850 }}>Recent translations</h3>
          {history.length === 0 && <p style={{ fontSize: 12, color: C.dim, margin: 0 }}>Nothing translated yet. Jobs started from an agent appear here too.</p>}
          {history.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: C.dim }}>
                    <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Video</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>Language</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(entry => {
                    const row = historyRow(entry);
                    return (
                      <tr key={row.id} onClick={() => loadJob(row)} style={{ cursor: 'pointer', borderTop: `1px solid ${C.line}` }}>
                        <td style={{ padding: '9px 10px 9px 0', fontWeight: 700, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.title}>{row.title}</td>
                        <td style={{ padding: '9px 10px', color: C.dim }}>{row.pair || '—'}</td>
                        <td style={{ padding: '9px 10px', color: row.state === 'done' ? C.good : row.state === 'error' ? C.danger : C.dim }}>
                          {row.state === 'done' ? 'Completed'
                            : row.state === 'error' ? 'Failed'
                              : row.state === 'cancelled' ? 'Cancelled'
                                : row.state === 'queued' ? 'Queued' : `Processing ${row.progress}%`}
                          {row.error ? <span style={{ display: 'block', fontSize: 10.5, color: C.dim }}>{row.error}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
