import { useEffect, useMemo, useRef, useState } from 'react';
import { SCRIPT_CHOICES, SAVE_CHOICES, cleanerBriefSummary, cleanerSetupError } from '../cleanerModel.mjs';
import CleanerReview from './CleanerReview';

const C = {
  bg: 'var(--vm-bg)', panel: 'var(--vm-panel)', raised: 'var(--vm-raised)', line: 'var(--vm-line)',
  text: 'var(--vm-text)', dim: 'var(--vm-muted)', teal: 'var(--vm-accent)', amber: 'var(--vm-accent)', danger: 'var(--vm-danger)',
};

const agentReady = agent => Boolean(agent?.installed && agent?.authed && agent?.subscriptionReady !== false);
const agentDetail = agent => {
  if (!agent.installed) return 'Not installed';
  if (!agent.authed) return 'Installed · sign in first';
  if (agent.subscriptionReady === false) return 'Signed in · subscription not recognized by Claude Code';
  return `Ready${agent.version ? ` · ${agent.version}` : ''}`;
};

function Choice({ selected, title, detail, onClick, disabled = false }) {
  return (
    <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick}
      style={{
        textAlign: 'left', padding: '14px 15px', borderRadius: 10, minHeight: 72,
        border: `1px solid ${selected ? C.teal : C.line}`,
        background: selected ? 'var(--vm-selected)' : C.raised,
        color: C.text, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .45 : 1,
        boxShadow: selected ? 'inset 3px 0 0 var(--vm-accent)' : 'none', transition: 'border-color 140ms ease, background 140ms ease',
      }}>
      <span style={{ display: 'block', fontWeight: 800, fontSize: 13 }}>{title}</span>
      {detail && <span style={{ display: 'block', color: C.dim, fontSize: 11, lineHeight: 1.45, marginTop: 5 }}>{detail}</span>}
    </button>
  );
}

function Section({ number, eyebrow, title, children }) {
  return (
    <section style={{ borderTop: `1px solid ${C.line}`, padding: '20px 0 22px' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
        <span style={{ color: C.amber, fontSize: 10, fontWeight: 900, letterSpacing: 1.6, paddingTop: 3 }}>{String(number).padStart(2, '0')}</span>
        <div>
          <div style={{ color: C.dim, fontSize: 9, fontWeight: 800, letterSpacing: 1.8, textTransform: 'uppercase' }}>{eyebrow}</div>
          <h3 style={{ color: C.text, fontSize: 17, margin: '3px 0 0', fontWeight: 850 }}>{title}</h3>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function CleanerStudio() {
  const hasBridge = typeof window !== 'undefined' && !!window.cleaner?.isElectron;
  const [sourcePath, setSourcePath] = useState('');
  const [scriptMode, setScriptMode] = useState('freestyle');
  const [scriptText, setScriptText] = useState('');
  const [includeMp4, setIncludeMp4] = useState(true);
  const [saveMode, setSaveMode] = useState('downloads');
  const [customOutputDir, setCustomOutputDir] = useState('');
  const [providerMode, setProviderMode] = useState('agent');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('anthropic/claude-sonnet-4.5');
  const [readiness, setReadiness] = useState({ agents: [], apiProviders: [] });
  const [loading, setLoading] = useState(hasBridge);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [project, setProject] = useState(null);
  const [plan, setPlan] = useState(null);
  const [progress, setProgress] = useState(null);
  const [output, setOutput] = useState(null);
  const [sourceUrl, setSourceUrl] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewRetry, setReviewRetry] = useState(0);
  const [confirmAnalysis, setConfirmAnalysis] = useState(false);
  const operationRef = useRef(false);

  const beginOperation = () => {
    if (operationRef.current) return false;
    operationRef.current = true;
    setBusy(true);
    return true;
  };
  const endOperation = () => {
    operationRef.current = false;
    setBusy(false);
  };

  useEffect(() => {
    if (!hasBridge) return;
    window.cleaner.readiness().then(result => {
      const next = result.ok ? result : { agents: [], apiProviders: [] };
      setReadiness(next);
      const readyAgent = next.agents.find(agentReady);
      if (readyAgent) setProviderId(readyAgent.id);
      setLoading(false);
    });
  }, [hasBridge]);
  useEffect(() => {
    if (!hasBridge || !window.cleaner.onProgress) return undefined;
    return window.cleaner.onProgress(event => {
      if (!project?.dir || !event.project_dir || event.project_dir === project.dir) setProgress(event);
    });
  }, [hasBridge, project?.dir]);
  useEffect(() => {
    if (!project?.dir || !plan) return undefined;
    let canceled = false;
    setReviewLoading(true); setReviewError(''); setSourceUrl(null);
    Promise.resolve().then(() => {
      if (!window.cleaner.review) throw new Error('Fully quit and reopen Vidmyo to load the new review player.');
      return window.cleaner.review(project.dir);
    }).then(result => {
      if (canceled) return;
      if (!result.ok) throw new Error(result.error);
      setPlan(result.plan); setSourceUrl(result.sourceUrl);
    }).catch(error => { if (!canceled) setReviewError(error.message); })
      .finally(() => { if (!canceled) setReviewLoading(false); });
    return () => { canceled = true; };
  }, [project?.dir, Boolean(plan), reviewRetry]);

  const providerName = providerMode === 'agent'
    ? readiness.agents.find(agent => agent.id === providerId)?.name
    : readiness.apiProviders.find(provider => provider.id === providerId)?.name;
  const summary = useMemo(() => cleanerBriefSummary({
    scriptMode, includeMp4, saveMode, providerMode, providerName,
  }), [scriptMode, includeMp4, saveMode, providerMode, providerName]);
  const setup = { sourcePath, scriptMode, scriptText, includeMp4, saveMode, customOutputDir, providerMode, providerId, model };
  const formError = cleanerSetupError(setup);
  const apiUnavailable = providerMode === 'api' && !readiness.apiProviders[0]?.configured;
  const canExport = Boolean(plan && !busy && !reviewLoading && sourceUrl && !plan.requires_reanalysis
    && !plan.summary.unreviewed_uncertain && plan.kept_ranges?.length
    && plan.decisions.some(item => item.decision === 'keep' && item.category !== 'pause'));

  const chooseSource = async () => {
    const result = await window.cleaner.pickSource();
    if (result.ok) { setSourcePath(result.path); setNotice(null); setProject(null); }
  };
  const chooseOutput = async () => {
    const result = await window.cleaner.pickOutput();
    if (result.ok) { setCustomOutputDir(result.path); setSaveMode('custom'); setNotice(null); }
  };
  const openProject = async () => {
    const result = await window.cleaner.pickProject();
    if (!result.ok) { if (!result.canceled) setNotice({ type: 'error', text: result.error }); return; }
    const manifest = result.manifest;
    setSourcePath(manifest.source?.uri || '');
    setScriptMode(manifest.intake?.script_mode || 'freestyle');
    setScriptText(manifest.intake?.script_text || '');
    setIncludeMp4(manifest.delivery?.include_mp4 !== false);
    setSaveMode(manifest.delivery?.save_mode || 'custom');
    setProviderMode(manifest.analysis?.mode === 'api' ? 'api' : 'agent');
    setProviderId(manifest.analysis?.provider || '');
    setModel(manifest.analysis?.model || 'anthropic/claude-sonnet-4.5');
    setProject(result); setPlan(result.plan); setOutput(manifest.outputs?.[0] || null);
    setNotice({ type: 'success', text: result.plan ? 'Cleaner project opened for review.' : 'Cleaner project opened.' });
  };
  const create = async () => {
    const error = cleanerSetupError(setup);
    if (error) { setNotice({ type: 'error', text: error }); return; }
    if (!beginOperation()) return;
    setNotice(null);
    try {
      const result = await window.cleaner.create(setup);
      if (!result.ok) { setNotice({ type: 'error', text: result.error }); return; }
      setProject(result);
      setNotice({ type: 'success', text: 'Cleaner project created. Start analysis when you are ready.' });
    } catch (error) {
      setNotice({ type: 'error', text: `Cleaner could not create the project: ${error?.message || error}` });
    } finally { endOperation(); }
  };
  const analyze = async () => {
    if (!project?.dir) return;
    if (!beginOperation()) return;
    setNotice(null); setProgress({ stage: 'ingest', fraction: 0, message: 'Starting local inspection' });
    try {
      const result = await window.cleaner.analyze(project.dir);
      if (!result.ok) { setNotice({ type: 'error', text: result.error }); return; }
      setProject(result); setPlan(result.plan);
      setOutput(null); setConfirmAnalysis(false); setReviewRetry(value => value + 1);
      setNotice({ type: 'success', text: 'Analysis complete. Review every proposed cut before export.' });
    } catch (error) {
      setNotice({ type: 'error', text: `Cleaner stopped before analysis completed: ${error?.message || error}. Fully quit and reopen Vidmyo, then open this project and retry.` });
    } finally { endOperation(); setProgress(null); }
  };
  const changeProvider = async event => {
    const nextProvider = event.target.value;
    if (!project?.dir || !nextProvider || nextProvider === providerId) return;
    if (!beginOperation()) return;
    try {
      const result = await window.cleaner.setProvider(project.dir, nextProvider);
      if (!result.ok) { setNotice({ type: 'error', text: result.error }); return; }
      setProviderId(nextProvider);
      setProviderMode('agent');
      setProject(current => ({ ...current, manifest: result.manifest }));
      setNotice({ type: 'success', text: `AI provider changed to ${readiness.agents.find(agent => agent.id === nextProvider)?.name || nextProvider}. Your completed transcript will be reused.` });
    } catch (error) {
      setNotice({ type: 'error', text: `Cleaner could not change provider: ${error?.message || error}` });
    } finally { endOperation(); }
  };
  const changeDecision = async (segmentId, decision, timing) => {
    if (!project?.dir || reviewLoading || !beginOperation()) return;
    try {
      const result = timing
        ? await window.cleaner.setBoundary(project.dir, segmentId, timing.seconds, timing.expectedSeconds)
        : await window.cleaner.setDecision(project.dir, segmentId, decision);
      if (!result.ok) throw new Error(result.error);
      setOutput(null);
      const review = await window.cleaner.review(project.dir);
      if (!review.ok) throw new Error(review.error);
      setPlan(review.plan); setSourceUrl(review.sourceUrl);
      setNotice(null);
    } catch (error) {
      setReviewError(`Could not refresh your decision: ${error.message}`);
      setSourceUrl(null);
    } finally { endOperation(); }
  };
  const render = async () => {
    if (!project?.dir) return;
    if (!beginOperation()) return;
    setNotice(null); setProgress({ stage: 'export', fraction: 0, message: 'Rendering locally' });
    try {
      const result = await window.cleaner.render(project.dir);
      if (!result.ok) { setNotice({ type: 'error', text: result.error }); return; }
      setProject(result); setOutput(result.output);
      setNotice({ type: 'success', text: 'Your cleaned video is ready.' });
    } catch (error) {
      setNotice({ type: 'error', text: `Cleaner stopped before export completed: ${error?.message || error}` });
    } finally { endOperation(); setProgress(null); }
  };

  if (!hasBridge) return (
    <div style={{ maxWidth: 620, margin: '90px auto', color: C.dim, textAlign: 'center' }}>
      <h2 style={{ color: C.text, fontSize: 24 }}>Cleaner runs in the Vidmyo desktop app</h2>
      <p>Open “Start Vidmyo” to select local footage, installed agents, and encrypted API credentials.</p>
    </div>
  );

  const editTools = (
          <aside style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: 18, borderBottom: `1px solid ${C.line}` }}>
              <div style={{ color: C.dim, fontSize: 9, letterSpacing: 1.8, fontWeight: 850 }}>EDIT BRIEF</div>
              <div style={{ color: C.text, fontSize: 15, fontWeight: 800, lineHeight: 1.5, marginTop: 9 }}>{summary}</div>
            </div>
            <div style={{ padding: 18 }}>
              <details><summary style={{ color: C.dim, fontSize: 12, cursor: 'pointer' }}>Edit brief & cleanup rules</summary>
              {[
                ['Remove retakes', 'Keep the strongest complete take'],
                ['Remove false starts', 'Drop aborted fragments and restarts'],
                ['Tighten dead air', 'Preserve natural conversational rhythm'],
                ['Keep filler words', 'Avoid distracting mid-sentence jump cuts'],
                ['Review before export', 'Every cut stays reversible'],
              ].map(([title, detail]) => <div key={title} style={{ display: 'flex', gap: 9, margin: '10px 0' }}><span style={{ color: C.teal }}>✓</span><div><div style={{ fontSize: 12, fontWeight: 750 }}>{title}</div><div style={{ color: C.dim, fontSize: 10, lineHeight: 1.4, marginTop: 2 }}>{detail}</div></div></div>)}</details>
              {notice && <div role="status" style={{ marginTop: 14, padding: '10px 11px', borderRadius: 8, background: notice.type === 'error' ? 'rgba(255,125,115,.1)' : 'rgba(89,214,199,.1)', color: notice.type === 'error' ? C.danger : C.teal, fontSize: 11, lineHeight: 1.45 }}>{notice.text}</div>}
              {progress && <div style={{ marginTop: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', color: C.dim, fontSize: 10 }}><span>{progress.message}</span><span>{progress.fraction == null ? '' : `${Math.round(progress.fraction * 100)}%`}</span></div><div style={{ height: 3, background: C.line, borderRadius: 3, marginTop: 7, overflow: 'hidden' }}><div style={{ width: `${Math.max(3, Math.round((progress.fraction || 0) * 100))}%`, height: '100%', background: C.teal }} /></div></div>}
              {!project && <button type="button" onClick={create} disabled={busy || !!formError || apiUnavailable} title={formError || (apiUnavailable ? 'Add an OpenRouter API key in Settings first.' : '')} style={{ width: '100%', marginTop: 16, padding: '12px 14px', border: 0, borderRadius: 9, background: 'var(--vm-primary)', color: 'var(--vm-on-primary)', fontSize: 12, fontWeight: 900, cursor: busy || formError || apiUnavailable ? 'not-allowed' : 'pointer', opacity: busy || formError || apiUnavailable ? .45 : 1 }}>{busy ? 'SAVING…' : 'CREATE CLEANER PROJECT →'}</button>}
              {project && !plan && <button type="button" onClick={analyze} disabled={busy} style={{ width: '100%', marginTop: 16, padding: '12px 14px', border: 0, borderRadius: 9, background: 'var(--vm-primary)', color: 'var(--vm-on-primary)', fontSize: 12, fontWeight: 900, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? .55 : 1 }}>{busy ? 'ANALYZING…' : 'ANALYZE RECORDING →'}</button>}
              {plan && <div style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5, color: C.dim }}>
                {plan.requires_reanalysis && <p style={{ color: C.amber }}>The earlier transcript may have missed repeated takes. Analyze again before exporting.</p>}
                {!confirmAnalysis ? <button disabled={busy || reviewLoading} onClick={() => setConfirmAnalysis(true)} style={{ color: C.teal }}>Analyze again with improved transcription</button>
                  : <><p>This preserves repeated takes with local transcription, then uses {providerName || 'your selected AI'} to propose a fresh edit. Your previous plan is archived. Matching reviewed choices are preserved; changed or unmatched sections are flagged for review. This uses your agent subscription or configured API.</p><button disabled={busy || reviewLoading} onClick={analyze} style={{ color: C.teal }}>Start new analysis</button><button disabled={busy} onClick={() => setConfirmAnalysis(false)} style={{ marginLeft: 16 }}>Cancel</button></>}
              </div>}
              {plan && includeMp4 && !output && <button type="button" onClick={render} disabled={!canExport} style={{ width: '100%', marginTop: 16, padding: '12px 14px', border: 0, borderRadius: 9, background: 'var(--vm-primary)', color: 'var(--vm-on-primary)', fontSize: 12, fontWeight: 900, cursor: canExport ? 'pointer' : 'not-allowed', opacity: canExport ? 1 : .55 }}>{busy ? 'WORKING…' : plan.summary.removed_seconds > 0 ? `EXPORT CLEANED VIDEO · ${Math.round(plan.summary.output_seconds)}s →` : 'EXPORT WITHOUT CUTS →'}</button>}
              {plan && !plan.decisions.some(item => item.decision === 'keep' && item.category !== 'pause') && <p role="alert" style={{ color: C.danger }}>Restore at least one speech section before exporting.</p>}
              {plan && !includeMp4 && <div style={{ color: C.teal, fontSize: 11, marginTop: 14 }}>Review plan ready. MP4 export was disabled in this project.</div>}
              {(formError || apiUnavailable) && !project && <div style={{ color: C.dim, fontSize: 10, textAlign: 'center', marginTop: 8 }}>{formError || 'Add an OpenRouter API key in Settings first.'}</div>}
              {project && <button type="button" onClick={() => window.cleaner.reveal(project.dir)} style={{ width: '100%', marginTop: 8, padding: 9, borderRadius: 8, border: `1px solid ${C.line}`, background: C.raised, color: C.text, fontSize: 11, cursor: 'pointer' }}>Show project folder</button>}
              <p style={{ color: C.dim, fontSize: 10, lineHeight: 1.5, margin: '13px 0 0' }}>No AI request is sent while you set this up. API keys stay in the OS keychain and are never written into the Cleaner project.</p>
            </div>
          </aside>
  );

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: C.bg, color: C.text }}>
      <div style={{ maxWidth: 1480, margin: '0 auto', padding: plan ? '20px 22px' : '26px 24px 70px' }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 24, alignItems: 'flex-end', marginBottom: 22 }}>
          <div>
            <div style={{ color: C.teal, fontSize: 10, fontWeight: 900, letterSpacing: 2.2, textTransform: 'uppercase' }}>Long-form cleanup</div>
            <h1 style={{ fontSize: 30, lineHeight: 1.08, margin: '7px 0 8px', letterSpacing: '-.7px' }}>Cleaner</h1>
            {!plan && <p style={{ color: C.dim, fontSize: 13, lineHeight: 1.55, maxWidth: 650, margin: 0 }}>
              Turn a raw talking-head recording into one coherent edit. Cleaner removes retakes, false starts, and dead air—then lets you review every decision before export.
            </p>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" disabled={busy || reviewLoading} onClick={openProject} style={{ padding: '7px 10px', borderRadius: 7, border: `1px solid ${C.line}`, background: C.panel, color: C.text, fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>Open project</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: C.dim, fontSize: 10, whiteSpace: 'nowrap' }}>
              <b style={{ color: !plan ? C.teal : C.dim }}>01 SETUP</b><span>—</span><b style={{ color: plan && !output ? C.teal : C.dim }}>02 REVIEW CUTS</b><span>—</span><b style={{ color: output ? C.teal : C.dim }}>03 EXPORT</b>
            </div>
          </div>
        </header>

        <div className="cleaner-grid" style={{ display: 'grid', gridTemplateColumns: plan ? 'minmax(0, 1fr)' : 'minmax(0, 1.6fr) minmax(300px, .85fr)', gap: 18, alignItems: 'start' }}>
          <main style={{ minWidth: 0, background: plan ? 'transparent' : C.panel, border: plan ? 0 : `1px solid ${C.line}`, borderRadius: 14, padding: plan ? 0 : '0 22px' }}>
            {plan ? <CleanerReview plan={plan} sourceUrl={sourceUrl} loading={reviewLoading} error={reviewError} onRetry={() => setReviewRetry(value => value + 1)} onDecision={changeDecision} disabled={busy} onEditedPreview={() => window.cleaner.review(project.dir, { edited: true })} onWaveform={window.cleaner.waveform ? () => window.cleaner.waveform(project.dir) : null} reviewTools={editTools} projectDir={project?.dir} /> : project ? (
              <div style={{ padding: 28 }}>
                <div style={{ color: C.teal, fontSize: 10, fontWeight: 900, letterSpacing: 1.8 }}>PROJECT READY</div>
                <h2 style={{ margin: '7px 0 8px', fontSize: 22 }}>Your edit brief is locked in</h2>
                <p style={{ color: C.dim, fontSize: 12, lineHeight: 1.6, maxWidth: 620 }}>Cleaner will inspect and transcribe the video locally, then the selected provider will identify only clear retakes, false starts, and directions to camera. No cuts are rendered until you review them.</p>
                <div style={{ marginTop: 18, border: `1px solid ${C.line}`, borderRadius: 10, background: C.raised, padding: 15 }}>
                  <div style={{ color: C.text, fontSize: 13, fontWeight: 800 }}>{summary}</div>
                  <div style={{ color: C.dim, fontSize: 10, marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourcePath}</div>
                </div>
                <label style={{ display: 'block', color: C.dim, fontSize: 10, marginTop: 16 }}>AI FOR CUT DECISIONS
                  <select value={providerId} onChange={changeProvider} disabled={busy} style={{ display: 'block', width: '100%', marginTop: 6, padding: '10px 11px', borderRadius: 8, background: 'var(--vm-input)', border: `1px solid ${C.line}`, color: C.text }}>
                    {readiness.agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agentReady(agent)}>{agent.name} — {agentDetail(agent)}</option>)}
                  </select>
                </label>
                <div style={{ color: C.dim, fontSize: 10, marginTop: 6 }}>Changing the agent keeps the completed local transcript and retries only the AI decision step.</div>
              </div>
            ) : <>
            <Section number={1} eyebrow="Source" title="Which recording should Cleaner edit?">
              <button type="button" onClick={chooseSource} style={{ width: '100%', border: `1px dashed ${sourcePath ? C.teal : C.line}`, borderRadius: 11, padding: '16px', background: C.raised, color: C.text, textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ display: 'block', color: sourcePath ? C.teal : C.amber, fontSize: 11, fontWeight: 850 }}>{sourcePath ? 'SOURCE READY' : 'CHOOSE VIDEO'}</span>
                <span style={{ display: 'block', marginTop: 5, color: sourcePath ? C.text : C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourcePath || 'MP4, MOV, MKV, WebM, or M4V'}</span>
              </button>
            </Section>

            <Section number={2} eyebrow="Recording plan" title="Did you film from a script?">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 9 }}>
                {SCRIPT_CHOICES.map(choice => <Choice key={choice.id} selected={scriptMode === choice.id} title={choice.label} detail={choice.detail} onClick={() => setScriptMode(choice.id)} />)}
              </div>
              {scriptMode !== 'freestyle' && (
                <textarea value={scriptText} onChange={event => setScriptText(event.target.value)}
                  aria-label={scriptMode === 'exact' ? 'Exact script' : 'Rough outline'}
                  placeholder={scriptMode === 'exact' ? 'Paste the exact script here…' : 'Paste the rough outline here…'}
                  style={{ width: '100%', boxSizing: 'border-box', minHeight: 130, resize: 'vertical', marginTop: 10, background: 'var(--vm-input)', border: `1px solid ${C.line}`, borderRadius: 10, color: C.text, padding: 13, fontSize: 12, lineHeight: 1.55, outlineColor: C.teal }} />
              )}
            </Section>

            <Section number={3} eyebrow="Delivery" title="What should Cleaner prepare?">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9, marginBottom: 12 }}>
                <Choice selected={includeMp4} title="Clean MP4 + review plan" detail="Default. Watch the edit and keep a reversible decision log." onClick={() => setIncludeMp4(true)} />
                <Choice selected={!includeMp4} title="Review plan only" detail="Skip the larger render; keep the cut decisions for later." onClick={() => setIncludeMp4(false)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 9 }}>
                {SAVE_CHOICES.map(choice => <Choice key={choice.id} selected={saveMode === choice.id} title={choice.label} onClick={() => choice.id === 'custom' ? chooseOutput() : setSaveMode(choice.id)} />)}
              </div>
              {saveMode === 'custom' && <div style={{ color: customOutputDir ? C.teal : C.dim, fontSize: 11, marginTop: 8, overflow: 'hidden', textOverflow: 'ellipsis' }}>{customOutputDir || 'No folder selected'}</div>}
            </Section>

            <Section number={4} eyebrow="AI decisions" title="Who should choose the best takes?">
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                {[
                  ['agent', 'Installed agent subscription'], ['api', 'API provider'],
                ].map(([id, label]) => <button key={id} type="button" onClick={() => { setProviderMode(id); setProviderId(id === 'api' ? 'openrouter' : readiness.agents.find(agentReady)?.id || ''); }} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${providerMode === id ? C.amber : C.line}`, background: providerMode === id ? 'rgba(241,185,73,.1)' : C.raised, color: providerMode === id ? C.amber : C.dim, fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>{label}</button>)}
              </div>
              {loading ? <div style={{ color: C.dim, fontSize: 12 }}>Detecting agents on this machine…</div> : providerMode === 'agent' ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9 }}>
                  {readiness.agents.map(agent => <Choice key={agent.id} selected={providerId === agent.id} title={agent.name} detail={agentDetail(agent)} disabled={!agentReady(agent)} onClick={() => setProviderId(agent.id)} />)}
                </div>
              ) : (
                <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: 11, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div><b style={{ fontSize: 13 }}>OpenRouter</b><div style={{ color: C.dim, fontSize: 11, marginTop: 4 }}>Use one saved API key to choose models from multiple providers.</div></div>
                    <span style={{ color: readiness.apiProviders[0]?.configured ? C.teal : C.danger, fontSize: 10, fontWeight: 900 }}>{readiness.apiProviders[0]?.configured ? 'KEY READY' : 'ADD KEY IN SETTINGS'}</span>
                  </div>
                  <label style={{ display: 'block', color: C.dim, fontSize: 10, marginTop: 13 }}>MODEL ID
                    <input value={model} onChange={event => setModel(event.target.value)} placeholder="anthropic/claude-sonnet-4.5" style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '10px 11px', borderRadius: 8, background: 'var(--vm-input)', border: `1px solid ${C.line}`, color: C.text, outlineColor: C.teal }} />
                  </label>
                </div>
              )}
            </Section>
            </>}
          </main>

          {!plan && editTools}
        </div>
      </div>
      <style>{`@media (max-width: 860px){main+aside{position:static!important}.cleaner-grid{grid-template-columns:1fr!important}} @media (prefers-reduced-motion:reduce){*{transition:none!important}}`}</style>
    </div>
  );
}
