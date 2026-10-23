'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_OUTPUT_HINT, EDITOR_FINAL_FILENAME, FACE_SHARE_SLIDER_MAX, LOCAL_ONLY_NOTICE,
  MAX_FACE_SHARE, NO_BRIDGE_NOTICE, PACING_CHOICES, QUALITY_CHOICES, defaultEditorForm,
  describeAnalysisJob, describeEditorJob, editorAgentOptions, editorEngineOptions, editorModeOptions,
  editorPayloadFromForm, exampleList, exampleProfileSummary, formatDurationMs,
  normalizeExampleUrl, stageChecklist, templateRows, validateEditorForm,
} from '../editorModel.mjs';

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

const STAGE_GLYPH = {
  done: '✓', running: '→', failed: '✕', skipped: '–', pending: '○',
};

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
const errorText = { display: 'block', margin: '6px 0 0', fontSize: 11, color: C.danger, lineHeight: 1.45 };

/** Every bridge call answers with an envelope: `{ ok: true, … }` or `{ ok: false, error }`. */
function unwrap(result) {
  if (!result || typeof result !== 'object') throw new Error('The desktop bridge did not answer.');
  if (result.ok === false) throw new Error(result.error || 'The desktop bridge reported an error.');
  const rest = { ...result };
  delete rest.ok;
  return rest;
}

const message = error => {
  const text = error && error.message ? error.message : String(error || 'Something went wrong.');
  // The renderer picks up a new preload on reload, but the main process keeps the
  // handlers it registered at launch. Without this the user sees Electron's raw
  // "No handler registered" string and has no idea that a restart is the fix.
  if (/No handler registered for 'editor:/i.test(text)) {
    return 'Vidmyo needs a restart: the Editor engine was installed after this window started, so the app is still running without its handlers. Quit Vidmyo completely and reopen it, then try again.';
  }
  return text;
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

function Swatches({ colors }) {
  if (!colors.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, verticalAlign: 'middle' }}>
      {colors.map(color => (
        <span key={color} title={color} style={{ width: 14, height: 14, borderRadius: 3, background: color, border: `1px solid ${C.line}` }} />
      ))}
    </span>
  );
}

export default function EditorStudio() {
  const [bridge, setBridge] = useState(null);
  const [bridgeChecked, setBridgeChecked] = useState(false);
  const [form, setForm] = useState(() => defaultEditorForm(null));
  const [capabilities, setCapabilities] = useState(null);
  const [capabilityError, setCapabilityError] = useState('');
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [analysis, setAnalysis] = useState({ jobId: null, job: null, profile: null, stopped: false });
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(null);

  const update = useCallback(patch => setForm(current => ({ ...current, ...patch })), []);

  // ── Bridge + capabilities + saved templates + recent edits ────────────────
  useEffect(() => {
    const api = typeof window !== 'undefined' ? (window.editor || null) : null;
    setBridge(api);
    setBridgeChecked(true);
    if (!api) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const caps = unwrap(await api.capabilities());
        if (cancelled) return;
        const value = caps.capabilities || null;
        setCapabilities(value);
        const engines = editorEngineOptions(value);
        const engine = engines[0]?.value || 'v1';
        const modes = editorModeOptions(value, engine);
        setForm(current => ({
          ...current,
          engine,
          mode: modes.some(option => option.value === current.mode) ? current.mode : (modes[0]?.value || 'original'),
        }));
      } catch (error) {
        if (!cancelled) setCapabilityError(message(error));
      }
      try {
        const saved = unwrap(await api.templates({ limit: 50 }));
        if (!cancelled) setTemplates(Array.isArray(saved.templates) ? saved.templates : []);
      } catch { /* the tab still works without a template list */ }
      try {
        const list = unwrap(await api.listJobs({ limit: 20 }));
        if (!cancelled) setHistory(Array.isArray(list.jobs) ? list.jobs : []);
      } catch { /* recent edits are a convenience, not a requirement */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshJob = useCallback(async jobId => {
    if (!bridge || !jobId) return null;
    try {
      const result = unwrap(await bridge.getJob(jobId));
      if (result.job) {
        setJob(result.job);
        return result.job;
      }
    } catch { /* a job that vanished must not wedge the panel */ }
    return null;
  }, [bridge]);

  // ── Progress events ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!bridge?.onProgress) return undefined;
    const unsubscribe = bridge.onProgress(event => {
      if (!event?.job_id) return;
      const eventState = event.state ? String(event.state) : null;
      const terminal = ['done', 'error', 'cancelled'].includes(eventState)
        || ['done', 'complete', 'error', 'failed', 'cancelled'].includes(String(event.event || ''));
      setJob(current => {
        if (!current || current.job_id !== event.job_id) return current;
        const stages = Array.isArray(current.stages) && event.stage && event.status
          ? current.stages.map(entry => (entry.id === event.stage ? { ...entry, status: event.status } : entry))
          : current.stages;
        return {
          ...current,
          state: eventState || current.state,
          stage: event.stage || current.stage,
          progress: Number.isFinite(Number(event.progress)) ? Number(event.progress) : current.progress,
          error: event.error || current.error,
          stages,
        };
      });
      setAnalysis(current => (current.jobId && current.jobId === event.job_id
        ? {
          ...current,
          job: {
            ...(current.job || { job_id: event.job_id }),
            state: eventState || current.job?.state,
            stage: event.stage || current.job?.stage,
            progress: Number.isFinite(Number(event.progress)) ? Number(event.progress) : current.job?.progress,
            error: event.error || current.job?.error,
          },
        }
        : current));
      if (terminal) refreshJob(event.job_id);
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [bridge, refreshJob]);

  // ── Poll the running job every 1.5 s ──────────────────────────────────────
  const activeJobId = job?.job_id || null;
  const activeState = job?.state || null;
  useEffect(() => {
    if (!bridge || !activeJobId) return undefined;
    if (!['queued', 'running'].includes(String(activeState))) return undefined;
    const timer = setInterval(() => { refreshJob(activeJobId); }, 1500);
    return () => clearInterval(timer);
  }, [bridge, activeJobId, activeState, refreshJob]);

  // ── Poll the style analysis until it lands a profile ──────────────────────
  const analysisJobId = analysis.jobId;
  const analysisStopped = analysis.stopped;
  useEffect(() => {
    if (!bridge || !analysisJobId || analysisStopped) return undefined;
    let misses = 0;
    const timer = setInterval(async () => {
      try {
        const result = unwrap(await bridge.getAnalysis(analysisJobId));
        const value = result.analysis || null;
        if (!value) {
          misses += 1;
          if (misses >= 8) setAnalysis(current => ({ ...current, stopped: true }));
          return;
        }
        misses = 0;
        const nextJob = value.job || value;
        const profile = value.profile || null;
        setAnalysis(current => ({ ...current, job: nextJob || current.job, profile: profile || current.profile }));
        if (profile || ['done', 'error', 'cancelled'].includes(String(nextJob?.state || ''))) {
          setAnalysis(current => ({ ...current, stopped: true }));
        }
      } catch {
        setAnalysis(current => ({ ...current, stopped: true }));
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [bridge, analysisJobId, analysisStopped]);

  // ── Picking paths ─────────────────────────────────────────────────────────
  const browseFolder = useCallback(async kind => {
    if (!bridge) return;
    try {
      const raw = await bridge.pickFolder(kind);
      if (!raw || raw.canceled) return;
      const result = unwrap(raw);
      if (!result.path) return;
      update(kind === 'input' ? { input_dir: result.path } : { output_dir: result.path });
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, update]);

  const browseFile = useCallback(async kind => {
    if (!bridge) return;
    try {
      const raw = await bridge.pickFile(kind);
      if (!raw || raw.canceled) return;
      const result = unwrap(raw);
      const picked = Array.isArray(result.paths) && result.paths.length ? result.paths : (result.path ? [result.path] : []);
      if (!picked.length) return;
      if (kind === 'music') update({ music_path: picked[0] });
      else update({ example_videos: [...new Set([...form.example_videos, ...picked])] });
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, form.example_videos, update]);

  // ── Examples + template ───────────────────────────────────────────────────
  const addUrl = useCallback(() => {
    const normalized = normalizeExampleUrl(urlDraft);
    if (!normalized) {
      setNotice({ kind: 'error', text: 'Paste an http(s) link to an example video.' });
      return;
    }
    update({ example_urls: [...new Set([...form.example_urls, normalized])] });
    setUrlDraft('');
    setNotice(null);
  }, [form.example_urls, update, urlDraft]);

  const analyze = useCallback(async () => {
    if (!bridge) return;
    const urls = form.example_urls.map(value => value.trim()).filter(Boolean);
    const videos = form.example_videos.map(value => value.trim()).filter(Boolean);
    if (!urls.length && !videos.length) {
      setNotice({ kind: 'error', text: 'Add an example link or video file first.' });
      return;
    }
    setAnalysisBusy(true);
    setNotice(null);
    try {
      const result = unwrap(await bridge.analyzeExamples({
        urls, videos, name: String(form.template_name || '').trim() || 'Style',
      }));
      const value = result.analysis || null;
      const analysisJob = value?.job || value || null;
      const jobId = analysisJob?.job_id || analysisJob?.id || null;
      setAnalysis({ jobId, job: analysisJob, profile: value?.profile || null, stopped: !jobId });
      if (!jobId) setNotice({ kind: 'error', text: 'The analysis was queued but no job id came back.' });
    } catch (error) {
      setNotice({ kind: 'error', text: message(error) });
    } finally {
      setAnalysisBusy(false);
    }
  }, [bridge, form.example_urls, form.example_videos, form.template_name]);

  const saveTemplate = useCallback(async () => {
    if (!bridge) return;
    const name = String(form.template_name || '').trim();
    if (!name) { setNotice({ kind: 'error', text: 'Give the template a name first.' }); return; }
    if (!analysis.profile) { setNotice({ kind: 'error', text: 'Analyse at least one example before saving a template.' }); return; }
    try {
      const result = unwrap(await bridge.saveTemplate({
        name,
        profile: analysis.profile,
        examples: exampleList(form),
        analysis_job_id: analysis.jobId,
        engine: form.engine,
      }));
      const saved = result.template || null;
      if (saved?.id) {
        setTemplates(current => [saved, ...current.filter(entry => entry?.id !== saved.id)]);
        update({ template_id: saved.id, mode: 'custom' });
      }
      setNotice({ kind: 'info', text: `Saved “${saved?.name || name}”. Later runs can apply it instead of analysing again.` });
    } catch (error) {
      setNotice({ kind: 'error', text: message(error) });
    }
  }, [analysis.jobId, analysis.profile, bridge, form, update]);

  const removeTemplate = useCallback(async id => {
    if (!bridge) return;
    if (deleteArmed !== id) { setDeleteArmed(id); return; }
    try {
      unwrap(await bridge.deleteTemplate(id));
      setTemplates(current => current.filter(entry => entry?.id !== id));
      if (form.template_id === id) update({ template_id: null });
      setDeleteArmed(null);
      setNotice({ kind: 'info', text: 'Template deleted.' });
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, deleteArmed, form.template_id, update]);

  // ── Start / cancel / retry ────────────────────────────────────────────────
  const validation = useMemo(() => validateEditorForm(form), [form]);
  const view = useMemo(() => describeEditorJob(job), [job]);
  const checklist = useMemo(() => stageChecklist(job), [job]);
  const analysisView = useMemo(() => describeAnalysisJob(analysis.job, analysis.profile), [analysis.job, analysis.profile]);
  const profileSummary = useMemo(() => exampleProfileSummary(analysis.profile), [analysis.profile]);
  const templateList = useMemo(() => templateRows(templates), [templates]);
  const engines = useMemo(() => editorEngineOptions(capabilities), [capabilities]);
  const modes = useMemo(() => editorModeOptions(capabilities, form.engine), [capabilities, form.engine]);
  const agentOptions = useMemo(() => editorAgentOptions(capabilities), [capabilities]);

  const start = useCallback(async () => {
    if (!bridge) return;
    const check = validateEditorForm(form);
    if (!check.ok) {
      setNotice({ kind: 'error', text: Object.values(check.errors)[0] });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = unwrap(await bridge.start(editorPayloadFromForm(form)));
      if (result.job) {
        setJob(result.job);
        setHistory(current => [result.job, ...current.filter(entry => entry?.job_id !== result.job.job_id)].slice(0, 20));
      } else {
        setNotice({ kind: 'error', text: 'The edit was started but no job came back.' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: message(error) });
    } finally {
      setBusy(false);
    }
  }, [bridge, form]);

  const cancel = useCallback(async () => {
    if (!bridge || !job?.job_id) return;
    try {
      const result = unwrap(await bridge.cancelJob(job.job_id));
      if (result.job) setJob(result.job);
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, job?.job_id]);

  const retry = useCallback(async () => {
    if (!bridge || !job?.job_id) return;
    try {
      const result = unwrap(await bridge.retryJob(job.job_id));
      if (result.job) setJob(result.job);
    } catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, job?.job_id]);

  const reveal = useCallback(async (artifact = null) => {
    if (!bridge || !job?.job_id) return;
    try { unwrap(await bridge.reveal(job.job_id, artifact)); }
    catch (error) { setNotice({ kind: 'error', text: message(error) }); }
  }, [bridge, job?.job_id]);

  const loadHistory = useCallback(row => { refreshJob(row?.job_id || row?.id); }, [refreshJob]);

  const disabled = !bridge;
  const running = view.isRunning;
  const finalArtifact = (job?.outputs || []).find(entry => /final/i.test(String(entry?.kind || ''))
    || new RegExp(`${EDITOR_FINAL_FILENAME.replace('.', '\\.')}$`, 'i').test(String(entry?.artifact || '')))?.artifact
    || `out/${EDITOR_FINAL_FILENAME}`;

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 18px 60px', height: '100%', overflowY: 'auto', boxSizing: 'border-box', color: C.text }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: 0, letterSpacing: 0.4 }}>Editor</h2>
        <span style={{ fontSize: 11, color: C.dim }}>Turn a folder of footage into an edit. V1 is the documentary engine.</span>
      </header>

      {bridgeChecked && !bridge && (
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.warning}`, background: C.raised, fontSize: 12, lineHeight: 1.55 }}>
          {NO_BRIDGE_NOTICE}
        </div>
      )}
      {capabilityError && (
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.warning}`, background: C.raised, fontSize: 12 }}>
          {capabilityError}
        </div>
      )}
      {notice && <p style={{ margin: '12px 0 0', fontSize: 12, color: notice.kind === 'error' ? C.danger : C.dim, overflowWrap: 'anywhere' }}>{notice.text}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 22, marginTop: 12 }}>
        {/* ── Form ─────────────────────────────────────────────────────────── */}
        <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${C.line}`, background: C.panel }}>
          <Section title="Engine">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
              <div>
                <Label>Edit engine</Label>
                <select value={form.engine} disabled={disabled} style={selectStyle}
                  onChange={event => {
                    const nextEngine = event.target.value;
                    const nextModes = editorModeOptions(capabilities, nextEngine).map(option => option.value);
                    update({ engine: nextEngine, mode: nextModes.includes(form.mode) ? form.mode : (nextModes[0] || 'original') });
                  }}>
                  {engines.map(engine => <option key={engine.value} value={engine.value}>{engine.label}</option>)}
                </select>
              </div>
              <div>
                <Label hint="Original needs no examples">Mode</Label>
                <div role="group" aria-label="Mode" style={{ display: 'inline-flex', padding: 3, borderRadius: 9, border: `1px solid ${C.line}`, background: C.input }}>
                  {modes.map(option => (
                    <button key={option.value} type="button" disabled={disabled} aria-pressed={form.mode === option.value}
                      onClick={() => update({ mode: option.value })}
                      style={{
                        padding: '8px 16px', borderRadius: 7, border: 'none',
                        background: form.mode === option.value ? C.selected : 'transparent',
                        color: form.mode === option.value ? C.text : C.dim,
                        fontWeight: 800, fontSize: 12.5, cursor: disabled ? 'not-allowed' : 'pointer',
                      }}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
              {engines.find(engine => engine.value === form.engine)?.description || ''}
            </p>
          </Section>

          <Section
            title="Brain"
            note="V1 cuts, renders and mixes on its own. An agent only chooses which real file illustrates each line — it never renders anything."
          >
            <div role="group" aria-label="Brain" style={{ display: 'inline-flex', padding: 3, borderRadius: 9, border: `1px solid ${C.line}`, background: C.input }}>
              {[{ value: 'none', label: 'On its own' }, { value: 'local', label: 'Local agent' }].map(option => (
                <button key={option.value} type="button" disabled={disabled} aria-pressed={form.brain_mode === option.value}
                  onClick={() => update({
                    brain_mode: option.value,
                    // Default to the first agent this machine can actually run, so the
                    // switch to "Local agent" is one click and not a hunt.
                    ...(option.value === 'local' && !form.brain_agent && agentOptions[0]
                      ? { brain_agent: agentOptions[0].value }
                      : {}),
                  })}
                  style={{
                    padding: '8px 16px', borderRadius: 7, border: 'none',
                    background: form.brain_mode === option.value ? C.selected : 'transparent',
                    color: form.brain_mode === option.value ? C.text : C.dim,
                    fontWeight: 800, fontSize: 12.5, cursor: disabled ? 'not-allowed' : 'pointer',
                  }}>
                  {option.label}
                </button>
              ))}
            </div>
            {form.brain_mode === 'local' && (
              <div style={{ marginTop: 14 }}>
                <Label hint="already installed and logged in on this machine">Agent</Label>
                {agentOptions.length ? (
                  <select value={form.brain_agent} disabled={disabled}
                    onChange={event => update({ brain_agent: event.target.value })} style={selectStyle}>
                    <option value="">Pick an agent…</option>
                    {agentOptions.map(agent => <option key={agent.value} value={agent.value}>{agent.label}</option>)}
                  </select>
                ) : (
                  <p style={{ margin: 0, fontSize: 12, color: C.danger }}>
                    No agent CLI was found on this machine. Install one (OpenCode, Hermes, Codex, Gemini or Claude Code)
                    and reopen Vidmyo, or leave the Editor on its own.
                  </p>
                )}
                {validation.errors.brain_agent && <span style={errorText}>{validation.errors.brain_agent}</span>}
                {(() => {
                  const chosen = agentOptions.find(agent => agent.value === form.brain_agent);
                  return chosen?.note ? <p style={{ margin: '8px 0 0', fontSize: 11, color: C.dim, lineHeight: 1.5 }}>{chosen.note}</p> : null;
                })()}
                <p style={{ margin: '8px 0 0', fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
                  The agent runs as your own CLI with its own login. Your Direct API keys are never used here, and nothing is uploaded from Vidmyo.
                </p>
              </div>
            )}
          </Section>

          <Section title="Footage">
            <Label hint="the folder the camera files live in">Input folder</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <input value={form.input_dir} disabled={disabled} placeholder="/Volumes/…/footage"
                onChange={event => update({ input_dir: event.target.value })}
                style={{ ...selectStyle, flex: '1 1 260px' }} />
              <button type="button" disabled={disabled} onClick={() => browseFolder('input')} style={buttonStyle('ghost', disabled)}>Browse…</button>
            </div>
            {validation.errors.input_dir && <span style={errorText}>{validation.errors.input_dir}</span>}

            <div style={{ marginTop: 14 }}>
              <Label hint="where the edit is written">Output folder</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <input value={form.output_dir} disabled={disabled} placeholder="/Volumes/…/edits"
                  onChange={event => update({ output_dir: event.target.value })}
                  style={{ ...selectStyle, flex: '1 1 260px' }} />
                <button type="button" disabled={disabled} onClick={() => browseFolder('output')} style={buttonStyle('ghost', disabled)}>Browse…</button>
              </div>
              {validation.errors.output_dir
                ? <span style={errorText}>{validation.errors.output_dir}</span>
                : null}
              <p style={{ margin: '6px 0 0', fontSize: 11, color: C.dim }}>Every run gets its own subfolder here — {DEFAULT_OUTPUT_HINT}.</p>
            </div>
          </Section>

          {form.mode === 'custom' && (
            <Section
              title="Style examples"
              note="The agent analyses these examples frame by frame — cut rhythm, palette, motion — and a saved template reuses that measurement on every later run."
            >
              <Label hint="YouTube or any http(s) link">Example links</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <input value={urlDraft} disabled={disabled} inputMode="url" placeholder="https://…"
                  onChange={event => setUrlDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addUrl(); } }}
                  style={{ ...selectStyle, flex: '1 1 260px' }} />
                <button type="button" disabled={disabled || !urlDraft.trim()} onClick={addUrl} style={buttonStyle('ghost', disabled || !urlDraft.trim())}>Add</button>
              </div>
              {form.example_urls.length > 0 && (
                <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                  {form.example_urls.map(url => (
                    <li key={url} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', fontSize: 12, borderBottom: `1px solid ${C.line}` }}>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: C.text }}>{url}</span>
                      <button type="button" disabled={disabled} onClick={() => update({ example_urls: form.example_urls.filter(value => value !== url) })}
                        style={{ ...buttonStyle('ghost', disabled), padding: '4px 10px', fontSize: 11 }}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}

              <div style={{ marginTop: 14 }}>
                <Label hint="files on this machine">Example video files</Label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                  <button type="button" disabled={disabled} onClick={() => browseFile('example-video')} style={buttonStyle('ghost', disabled)}>Browse…</button>
                  <span style={{ fontSize: 12, color: C.dim }}>{form.example_videos.length ? `${form.example_videos.length} file(s) selected` : 'none selected'}</span>
                </div>
                {form.example_videos.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                    {form.example_videos.map(path => (
                      <li key={path} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', fontSize: 12, borderBottom: `1px solid ${C.line}` }}>
                        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{path}</span>
                        <button type="button" disabled={disabled} onClick={() => update({ example_videos: form.example_videos.filter(value => value !== path) })}
                          style={{ ...buttonStyle('ghost', disabled), padding: '4px 10px', fontSize: 11 }}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                <button type="button" disabled={disabled || analysisBusy} onClick={analyze} style={buttonStyle('ghost', disabled || analysisBusy)}>
                  {analysisBusy ? 'Starting analysis…' : 'Analyze examples'}
                </button>
                {validation.errors.examples && <span style={{ fontSize: 11, color: C.danger, alignSelf: 'center' }}>{validation.errors.examples}</span>}
              </div>

              {analysis.jobId && (
                <div style={{ marginTop: 12, padding: 12, borderRadius: 9, border: `1px solid ${C.line}`, background: C.raised }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12, fontWeight: 800 }}>{analysisView.summary}</span>
                    {analysisView.isRunning && <span style={{ fontSize: 11, color: C.dim }}>{analysisView.progress}%</span>}
                  </div>
                  {analysisView.isRunning && (
                    <div style={{ height: 5, borderRadius: 999, background: C.panel, margin: '10px 0 0', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${analysisView.progress}%`, background: C.accent, transition: 'width 320ms ease' }} />
                    </div>
                  )}
                  {profileSummary.lines.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: C.dim, lineHeight: 1.7 }}>
                        {profileSummary.lines.map(line => <li key={line}>{line}</li>)}
                      </ul>
                      <div style={{ marginTop: 8 }}><Swatches colors={profileSummary.palette} /></div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                <input value={form.template_name} disabled={disabled} placeholder="Template name"
                  onChange={event => update({ template_name: event.target.value })}
                  style={{ ...selectStyle, flex: '1 1 200px' }} />
                <button type="button" disabled={disabled || !analysis.profile} onClick={saveTemplate}
                  style={buttonStyle('ghost', disabled || !analysis.profile)}>Save as template</button>
              </div>

              <div style={{ marginTop: 16 }}>
                <Label hint="applies to this run">Saved templates</Label>
                {templateList.length === 0 && <p style={{ margin: 0, fontSize: 11.5, color: C.dim }}>No templates yet.</p>}
                {templateList.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {templateList.map(row => (
                      <li key={row.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline', padding: '7px 0', borderTop: `1px solid ${C.line}`, fontSize: 12 }}>
                        <span style={{ flex: '1 1 180px', minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 800, color: C.text }}>{row.name}</span>
                          <span style={{ display: 'block', color: C.dim, fontSize: 11, marginTop: 2 }}>{row.detail}</span>
                        </span>
                        <Swatches colors={row.palette} />
                        <button type="button" disabled={disabled} onClick={() => update({ template_id: row.id, mode: 'custom' })}
                          aria-pressed={form.template_id === row.id}
                          style={{ ...buttonStyle('ghost', disabled), padding: '5px 10px', fontSize: 11, borderColor: form.template_id === row.id ? C.accent : C.line, background: form.template_id === row.id ? C.selected : C.raised }}>
                          {form.template_id === row.id ? 'Applied' : 'Apply'}
                        </button>
                        <button type="button" disabled={disabled} onClick={() => removeTemplate(row.id)}
                          style={{ ...buttonStyle('ghost', disabled), padding: '5px 10px', fontSize: 11, color: C.danger }}>
                          {deleteArmed === row.id ? 'Confirm delete' : 'Delete'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {form.template_id && (
                  <p style={{ margin: '8px 0 0', fontSize: 11, color: C.dim }}>
                    This run uses the saved template {templateList.find(row => row.id === form.template_id)?.name || form.template_id}.
                    {' '}
                    <button type="button" disabled={disabled} onClick={() => update({ template_id: null })}
                      style={{ background: 'none', border: 'none', color: C.accent, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 11, padding: 0 }}>
                      Clear
                    </button>
                  </p>
                )}
              </div>
            </Section>
          )}

          <Section title="Options">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
              <div>
                <Label>Quality</Label>
                <select value={form.quality} disabled={disabled} onChange={event => update({ quality: event.target.value })} style={selectStyle}>
                  {QUALITY_CHOICES.map(choice => <option key={choice.id} value={choice.id}>{choice.label} — {choice.detail}</option>)}
                </select>
              </div>
              <div>
                <Label>Pacing</Label>
                <select value={form.pacing} disabled={disabled} onChange={event => update({ pacing: event.target.value })} style={selectStyle}>
                  {PACING_CHOICES.map(choice => <option key={choice.id} value={choice.id}>{choice.label} — {choice.detail}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <Label hint={`${Math.round(form.face_share * 100)}% of the runtime`}>Face share</Label>
              <input type="range" min={0} max={FACE_SHARE_SLIDER_MAX} step={0.05} value={form.face_share}
                disabled={disabled} onChange={event => update({ face_share: Number(event.target.value) })}
                style={{ width: '100%', accentColor: C.accent }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: C.dim }}>
                <span>0% — every shot is a picture</span>
                <span>{Math.round(MAX_FACE_SHARE * 100)}% max</span>
              </div>
              {validation.errors.face_share && <span style={errorText}>{validation.errors.face_share}</span>}
            </div>

            <div style={{ marginTop: 14 }}>
              <Label hint="optional">Music bed</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button type="button" disabled={disabled} onClick={() => browseFile('music')} style={buttonStyle('ghost', disabled)}>Browse…</button>
                <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: form.music_path ? C.text : C.dim, overflowWrap: 'anywhere' }}>
                  {form.music_path || 'No music bed — the take keeps its own sound.'}
                </span>
                {form.music_path && (
                  <button type="button" disabled={disabled} onClick={() => update({ music_path: null })}
                    style={{ ...buttonStyle('ghost', disabled), padding: '5px 10px', fontSize: 11 }}>Clear</button>
                )}
              </div>
              {validation.errors.music_path && <span style={errorText}>{validation.errors.music_path}</span>}
            </div>
          </Section>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', borderTop: `1px solid ${C.line}`, paddingTop: 16 }}>
            <button type="button" onClick={start} disabled={disabled || busy || running || !validation.ok}
              style={buttonStyle('primary', disabled || busy || running || !validation.ok)}>
              {running ? 'EDITING…' : 'START EDIT'}
            </button>
            {running && <button type="button" disabled={disabled} onClick={cancel} style={buttonStyle('ghost', disabled)}>Cancel</button>}
            {view.isFailed && <button type="button" disabled={disabled} onClick={retry} style={buttonStyle('ghost', disabled)}>Retry from the failed stage</button>}
            <span style={{ alignSelf: 'center', fontSize: 11, color: C.dim }}>{LOCAL_ONLY_NOTICE}</span>
          </div>
        </div>

        {/* ── Progress / result ─────────────────────────────────────────────── */}
        {job && (
          <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${C.line}`, background: C.panel }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 850 }}>
                {view.isDone ? 'Edit finished' : view.isFailed ? 'Edit failed' : view.isCancelled ? 'Edit cancelled' : 'Editing footage'}
              </h3>
              <span style={{ fontSize: 12, color: C.dim }}>{view.progress}%</span>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: view.isFailed ? C.danger : C.dim }}>{view.summary}</p>
            <div style={{ height: 6, borderRadius: 999, background: C.raised, margin: '12px 0 16px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${view.progress}%`, background: view.isFailed ? C.danger : C.accent, transition: 'width 320ms ease' }} />
            </div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {checklist.map(entry => (
                <li key={entry.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', fontSize: 12.5 }}>
                  <span aria-hidden="true" style={{ color: STAGE_GLYPH_COLOR[entry.status] || C.dim, width: 14, fontFamily: 'ui-monospace, monospace' }}>
                    {STAGE_GLYPH[entry.status] || STAGE_GLYPH.pending}
                  </span>
                  <span style={{ color: entry.status === 'pending' ? C.dim : C.text, fontWeight: entry.status === 'running' ? 800 : 600 }}>
                    {entry.label}
                  </span>
                  {entry.error && <span style={{ color: C.dim, fontSize: 11 }}>· {entry.error}</span>}
                </li>
              ))}
            </ul>

            {view.error && <p style={{ margin: '14px 0 0', fontSize: 12, color: C.danger, overflowWrap: 'anywhere' }}>{view.error}</p>}

            {view.isDone && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
                <p style={{ margin: 0, fontSize: 12, color: C.text, overflowWrap: 'anywhere' }}>
                  {EDITOR_FINAL_FILENAME} · {view.outputPath || 'in the project folder'}
                  {view.durationMs ? ` · ${formatDurationMs(view.durationMs)}` : ''}
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                  <button type="button" onClick={() => reveal(null)} style={buttonStyle('ghost')}>Open output folder</button>
                  <button type="button" onClick={() => reveal(finalArtifact)} style={buttonStyle('ghost')}>Reveal {EDITOR_FINAL_FILENAME}</button>
                </div>
                <p style={{ margin: '12px 0 0', fontSize: 11, color: C.dim }}>{LOCAL_ONLY_NOTICE}</p>
              </div>
            )}

            {view.warnings.length > 0 && (
              <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 11.5, color: C.dim, lineHeight: 1.6 }}>
                {view.warnings.map(text => <li key={text}>{text}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* ── Recent edits ──────────────────────────────────────────────────── */}
        <div style={{ padding: 18, borderRadius: 14, border: `1px solid ${C.line}`, background: C.panel }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 850 }}>Recent edits</h3>
          {history.length === 0 && <p style={{ fontSize: 12, color: C.dim, margin: 0 }}>Nothing edited yet. Jobs started from an agent appear here too.</p>}
          {history.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: C.dim }}>
                    <th style={{ padding: '6px 10px 6px 0', fontWeight: 700 }}>Footage</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>Stage</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => {
                    const rowView = describeEditorJob(row);
                    const label = row?.input?.name || row?.input?.path || 'footage';
                    return (
                      <tr key={row.job_id} onClick={() => loadHistory(row)} style={{ cursor: 'pointer', borderTop: `1px solid ${C.line}` }}>
                        <td style={{ padding: '9px 10px 9px 0', fontWeight: 700, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(label)}>{String(label)}</td>
                        <td style={{ padding: '9px 10px', color: C.dim }}>{rowView.stageLabel || '—'}</td>
                        <td style={{ padding: '9px 10px', color: rowView.isDone ? C.good : rowView.isFailed ? C.danger : C.dim }}>
                          {rowView.isDone ? 'Finished'
                            : rowView.isFailed ? 'Failed'
                              : rowView.isCancelled ? 'Cancelled'
                                : rowView.state === 'queued' ? 'Queued' : `Editing ${rowView.progress}%`}
                          {rowView.error ? <span style={{ display: 'block', fontSize: 10.5, color: C.dim }}>{rowView.error.slice(0, 120)}</span> : null}
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
