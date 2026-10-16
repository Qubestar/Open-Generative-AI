"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import CaptionStudio from './CaptionStudio';
import { CAPTION_LOOKS, captionChoice, captionVariant, settingsFromRenderArtifact } from '../captionStudioModel.mjs';
import {
  bestRepurposeJob,
  deriveRepurposeStages,
  formatRepurposeDuration,
  joinRepurposeCandidates,
  mergeRepurposeProgress,
  normalizeRepurposeError,
  repurposeRenderEligibility,
  repurposeCandidateSelectable,
  repurposeFramingChanged,
  repurposeRuntimeBlockReason,
  readRepurposeReadiness,
  repurposeReviewNextStep,
  reviewCandidates,
} from '../repurposeModel.mjs';

const PLATFORMS = [
  ['youtube_shorts', 'YouTube Shorts'],
  ['tiktok', 'TikTok'],
  ['instagram_reels', 'Instagram Reels'],
];

const CONTENT_TYPES = [
  ['auto', 'Auto detect'],
  ['podcast', 'Podcast'],
  ['interview', 'Interview'],
  ['talking_head', 'Talking head'],
  ['tutorial', 'Tutorial'],
];

const TRANSCRIPTION_MODELS = ['tiny', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en'];

const RERUN_IMPACT = {
  generate_candidates: 'This replaces the current candidates and clears their approvals. Rank, previews, vertical framing, and Finish will need to run again.',
  rank: 'This updates the recommendations. Cut previews, vertical framing, and Finish will need to run again.',
  repair_boundaries: 'This rebuilds the cuts. Vertical framing and Finish will need to run again.',
  reframe: 'This rebuilds the vertical previews. Finish will need to run again.',
  render: 'This renders the selected clips again with the current Finish settings.',
};

function Icon({ name, size = 18 }) {
  const paths = {
    folder: <><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/></>,
    film: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4"/></>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    x: <path d="m7 7 10 10M17 7 7 17"/>,
    rotate: <><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    reveal: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.9 2.9-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.9-2.9.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.9-2.9.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.9 2.9-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function StatusMark({ state }) {
  return <span className={`rep-status rep-status--${state}`}><span className="rep-status__dot" />{state}</span>;
}

function DesktopRequired() {
  return (
    <main className="repurpose-studio rep-empty">
      <div className="rep-empty__mark"><Icon name="film" size={30} /></div>
      <p className="rep-kicker">Local media workspace</p>
      <h1>Clipper runs in the Vidmyo desktop app.</h1>
      <p>The desktop app keeps source videos and generated clips on this computer and provides the local Python and FFmpeg bridge.</p>
    </main>
  );
}

function EmptyProject({ form, setForm, chooseSource, chooseProject, createProject, openProject, busy, error }) {
  const togglePlatform = id => setForm(current => ({
    ...current,
    targetPlatforms: current.targetPlatforms.includes(id)
      ? current.targetPlatforms.filter(item => item !== id)
      : [...current.targetPlatforms, id],
  }));
  return (
    <main className="repurpose-studio rep-empty-state">
      <section className="rep-empty-state__intro">
        <p className="rep-kicker">Clipper / local beta</p>
        <h1>Find the cuts worth keeping.</h1>
        <p>Turn one long recording into reviewed vertical clips. Analysis, previews, captions, and exports stay on this computer.</p>
        <div className="rep-empty-state__rail" aria-hidden="true">
          <span>Long recording</span><i /><i /><i /><strong>Selected cuts</strong>
        </div>
        <button className="rep-button rep-button--quiet" onClick={openProject} disabled={busy}>
          <Icon name="folder" /> Open an existing project
        </button>
      </section>

      <section className="rep-setup" aria-label="Create a Clipper project">
        <div className="rep-section-heading">
          <span className="rep-timecode">NEW / 01</span>
          <div><h2>Start from a local video</h2><p>Choose the source and where Vidmyo should keep its working files.</p></div>
        </div>
        {error && <div className="rep-alert" role="alert">{error}</div>}
        <div className="rep-picker-grid">
          <button className="rep-picker" onClick={chooseSource} disabled={busy}>
            <Icon name="film" /><span><b>Source video</b><small>{form.sourcePath || 'Choose MP4, MOV, MKV, WebM, or M4V'}</small></span><Icon name="arrow" />
          </button>
          <button className="rep-picker" onClick={chooseProject} disabled={busy}>
            <Icon name="folder" /><span><b>Project folder</b><small>{form.projectDir || 'Choose an empty working folder'}</small></span><Icon name="arrow" />
          </button>
        </div>
        <div className="rep-field-row">
          <label><span>Clips to find</span><input type="number" min="1" max="20" value={form.requestedClipCount} onChange={event => setForm(current => ({ ...current, requestedClipCount: event.target.value }))} /></label>
          <label><span>Recording type</span><select value={form.contentType} onChange={event => setForm(current => ({ ...current, contentType: event.target.value }))}>{CONTENT_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label><span>Caption treatment</span><select value={form.captionStyle} onChange={event => setForm(current => ({ ...current, captionStyle: event.target.value }))}>{CAPTION_LOOKS.map(look => <option key={look.id} value={look.id}>{look.name}</option>)}</select></label>
          <label><span>Caption position</span><select value={form.captionPosition} onChange={event => setForm(current => ({ ...current, captionPosition: event.target.value }))}><option value="upper">Higher</option><option value="middle">Middle</option><option value="lower">Lower</option></select></label>
        </div>
        <fieldset className="rep-platforms"><legend>Delivery formats</legend>{PLATFORMS.map(([id, label]) => <label key={id}><input type="checkbox" checked={form.targetPlatforms.includes(id)} onChange={() => togglePlatform(id)} /><span>{label}</span></label>)}</fieldset>
        <p className="rep-delivery__hint">One selected format creates one universal 9:16 MP4 per clip. Select all three only when you need separately encoded platform files.</p>
        <label className="rep-switch"><input type="checkbox" checked={form.captionsEnabled} onChange={event => setForm(current => ({ ...current, captionsEnabled: event.target.checked }))} /><span>Render captions on finished clips</span></label>
        <button className="rep-button rep-button--primary rep-setup__submit" onClick={createProject} disabled={busy || !form.sourcePath || !form.projectDir || !form.targetPlatforms.length}>
          {busy ? 'Creating project…' : 'Create project'} <Icon name="arrow" />
        </button>
      </section>
    </main>
  );
}

function CutRail({ stages, progressByJob, runStage, rerunStage, resumeJob, cancelJob, busy, launchBlockReason }) {
  return (
    <section className="rep-cut-rail" aria-label="Repurpose stages">
      <div className="rep-cut-rail__line" aria-hidden="true" />
      {stages.map(stage => {
        const blockReason = launchBlockReason(stage.id);
        const liveProgress = stage.job ? progressByJob[stage.job.id] : null;
        const fraction = Number(liveProgress?.payload?.fraction ?? stage.progress?.fraction);
        const percent = Number.isFinite(fraction) ? Math.max(0, Math.min(100, Math.round(fraction * 100))) : null;
        return (
          <article key={stage.id} className={`rep-stage rep-stage--${stage.state}${stage.runnable || stage.rerunnable ? ' is-runnable' : ''}`}>
            <button
              className="rep-stage__head"
              onClick={() => stage.runnable
                ? runStage(stage.id)
                : stage.rerunnable ? rerunStage(stage.id)
                : stage.resumable ? resumeJob(stage.job.id) : undefined}
              disabled={busy || (!stage.runnable && !stage.rerunnable && !stage.resumable)}
              title={stage.runnable && blockReason ? blockReason : undefined}
              aria-label={`${stage.label}: ${stage.state}${stage.runnable ? '. Run stage' : stage.rerunnable ? '. Run again' : stage.resumable ? '. Resume stage' : ''}`}
            >
              <span className="rep-stage__number">{String(stage.index + 1).padStart(2, '0')}</span>
              <span className="rep-stage__node">{stage.state === 'completed' ? <Icon name="check" size={14} /> : stage.state === 'running' || stage.state === 'queued' ? <span className="rep-pulse" /> : null}</span>
              <span className="rep-stage__copy"><b>{stage.label}</b><small>{stage.runnable && blockReason ? 'Setup required' : stage.runnable ? 'Ready — click to run' : stage.rerunnable ? 'Completed — click to run again' : stage.state === 'blocked' ? 'Waiting' : stage.state}</small></span>
            </button>
            {(stage.state === 'running' || stage.state === 'queued') && (
              <div className="rep-stage__progress">
                <span style={{ width: `${percent ?? 8}%` }} />
                <small>{liveProgress?.substep || stage.progress?.substep || (stage.state === 'queued' ? 'Queued' : 'Working')}{percent !== null ? ` · ${percent}%` : ''}</small>
                <button onClick={() => cancelJob(stage.job.id)} aria-label={`Cancel ${stage.label}`}><Icon name="stop" size={12} /></button>
              </div>
            )}
            {stage.error && <p className="rep-stage__error">{normalizeRepurposeError(stage.error)}</p>}
          </article>
        );
      })}
    </section>
  );
}

function CandidateCard({ candidate, active, onOpen, onDecision, onSelect, onGeneratePreview, canGeneratePreview, generating, disabled }) {
  const rank = candidate.metadata?.ranking;
  const duration = formatRepurposeDuration(candidate.durationSeconds);
  return (
    <article className={`rep-candidate ${active ? 'is-active' : ''}`}>
      <button className="rep-candidate__open" onClick={onOpen} aria-pressed={active}>
        <span className="rep-candidate__index">{candidate.id.replace('clip_', '#')}</span>
        <span className="rep-candidate__body">
          <span className="rep-candidate__topline">
            <b>{candidate.metadata?.title || candidate.metadata?.hook || 'Untitled moment'}</b>
            <span className="rep-timecode">{duration}</span>
          </span>
          <span className="rep-candidate__summary">{candidate.metadata?.summary || candidate.metadata?.selection_reason || 'Transcript-grounded candidate'}</span>
          <span className="rep-candidate__signals">
            {rank?.recommended && <em>Recommended</em>}
            {rank?.overall_rank && <span>Rank {rank.overall_rank}</span>}
            {(candidate.metadata?.signal_types || []).slice(0, 2).map(signal => <span key={signal}>{String(signal).replaceAll('_', ' ')}</span>)}
          </span>
        </span>
      </button>
      <div className="rep-candidate__preview">
        {candidate.preview ? <span>{candidate.reframeV2?.output?.state === 'completed' ? 'Vertical preview ready' : 'Horizontal preview ready'}</span>
          : <button onClick={onGeneratePreview} disabled={disabled || !canGeneratePreview}>{generating ? 'Generating preview…' : 'Generate preview'}</button>}
      </div>
      <div className="rep-candidate__actions" aria-label={`Review ${candidate.id}`}>
        <button className={candidate.decision === 'approved' ? 'is-approved' : ''} onClick={() => onDecision('approved')} disabled={disabled}><Icon name="check" size={14} /> Approve</button>
        <button className={candidate.decision === 'rejected' ? 'is-rejected' : ''} onClick={() => onDecision('rejected')} disabled={disabled}><Icon name="x" size={14} /> Reject</button>
        <label className={candidate.selected ? 'is-selected' : ''} title={candidate.decision !== 'approved' ? 'Approve this clip first.' : 'Select this clip for export. Previews and vertical framing are required before Finish.'}><input type="checkbox" checked={candidate.selected} onChange={event => onSelect(event.target.checked)} disabled={!repurposeCandidateSelectable(candidate, disabled)} />Use in render</label>
      </div>
    </article>
  );
}

function Monitor({ candidate, previewUrl, previewBusy, previewError, loadPreview, generatePreview, canGeneratePreview, busy }) {
  return (
    <section className="rep-monitor" aria-label="Clip monitor">
      <div className="rep-monitor__screen">
        {previewUrl ? <video src={previewUrl} controls playsInline aria-label={`Preview ${candidate?.id || ''}`} /> : (
          <div className="rep-monitor__placeholder">
            <span className="rep-monitor__safe" />
            <div className="rep-monitor__play"><Icon name="play" size={24} /></div>
            <p>{previewBusy ? 'Loading local preview…' : candidate?.preview ? 'Preview ready on this computer' : candidate ? 'This candidate has no preview yet.' : 'Choose a candidate to review.'}</p>
            {candidate?.preview && !previewBusy && <button onClick={loadPreview}>Load preview</button>}
            {candidate && !candidate.preview && <button onClick={() => generatePreview(candidate.id)} disabled={busy || !canGeneratePreview}>Generate preview</button>}
          </div>
        )}
      </div>
      <div className="rep-monitor__strip">
        <span className="rep-timecode">{candidate ? candidate.id.toUpperCase() : 'NO CLIP'}</span>
        <span>{candidate?.reframeV2?.output?.state === 'completed' ? 'Vertical · 9:16' : candidate?.preview ? 'Horizontal · source' : 'No preview'}</span>
        <span>{candidate?.preview ? 'Local preview' : 'Waiting for media'}</span>
      </div>
      {previewError && <p className="rep-monitor__error" role="alert">{previewError}</p>}
    </section>
  );
}

function ReadinessPanel({ readiness, config, setModelCache, setTranscriptionModel, saveModelConfig, setupModel, recheckRuntime, busy, setupBusy, open, onToggle }) {
  const checks = [
    ['Python', readiness?.python?.ok],
    ['Engine', readiness?.engine?.ok],
    ['FFmpeg', readiness?.ffmpeg?.ok],
    ['FFprobe', readiness?.ffprobe?.ok],
  ];
  const modelReady = Boolean(readiness?.model?.ok || readiness?.model?.model_ready || readiness?.model?.status === 'ready');
  const modelName = config.transcriptionModel || readiness?.model?.model || 'small';
  return (
    <details className="rep-readiness" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
      <summary><Icon name="settings" size={15} /><span>Local setup</span><StatusMark state={readiness?.ok ? (modelReady ? 'ready' : 'attention') : 'blocked'} /></summary>
      <div className="rep-readiness__body">
        <div className="rep-readiness__checks">{checks.map(([name, ok]) => <span key={name} className={ok ? 'is-ok' : 'is-missing'}>{ok ? '✓' : '×'} {name}</span>)}</div>
        {readiness && !readiness.ok && <p role="alert">{repurposeRuntimeBlockReason(readiness)}</p>}
        {['python', 'engine', 'ffmpeg', 'ffprobe'].filter(key => readiness?.[key] && !readiness[key].ok).map(key => <p key={key} className="rep-readiness__path">{key}: {readiness[key].error || readiness[key].output || 'Check did not complete.'}</p>)}
        <button onClick={recheckRuntime} disabled={busy || setupBusy}>Recheck local setup</button>
        <p>{modelReady ? `The local ${modelName} transcription model is ready.` : `Transcription needs a local ${modelName} speech model. Select an existing model folder or a Vidmyo cache root, then save.`}</p>
        {readiness?.model?.model_path && <p className="rep-readiness__path">Resolved model: {readiness.model.model_path}</p>}
        <label><span>Transcription model</span><select value={modelName} onChange={event => setTranscriptionModel(event.target.value)}>{TRANSCRIPTION_MODELS.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        <label><span>Model folder or cache root</span><input value={config.modelCache || ''} onChange={event => setModelCache(event.target.value)} placeholder={readiness?.model?.model_cache || 'Absolute path to a local model or cache'} /></label>
        <button onClick={saveModelConfig} disabled={busy}>Save model settings</button>
        {!modelReady && <button onClick={setupModel} disabled={busy}>{setupBusy ? `Installing ${modelName}…` : `Install ${modelName} model…`}</button>}
      </div>
    </details>
  );
}

function AnalysisProviderPanel({ readiness, config, lockedProvider, lockedModel, busy, saveAnalysisConfig, setOpenRouterModel }) {
  const agents = readiness?.analysis?.agents || [];
  const detected = agents.filter(agent => agent.installed || agent.desktopApp);
  const visibleAgents = lockedProvider && lockedProvider !== 'openrouter' && !detected.some(agent => agent.id === lockedProvider)
    ? [...detected, agents.find(agent => agent.id === lockedProvider) || { id: lockedProvider, name: lockedProvider }]
    : detected;
  const selected = lockedProvider || config.analysisProvider || '';
  const agent = agents.find(item => item.id === selected);
  const openRouter = readiness?.analysis?.openrouter;
  const status = selected === 'openrouter'
    ? (openRouter?.authed ? 'OpenRouter key is ready.' : 'Add an OpenRouter key in Settings before running this stage.')
    : agent
      ? (agent.authed ? `${agent.repurposeName || agent.name} is ready.` : `${agent.repurposeName || agent.name} needs authentication.`)
      : 'Choose OpenRouter or an installed local agent.';
  return (
    <section className="rep-analysis-provider" aria-label="AI agent selection">
      <div>
        <p className="rep-kicker">Analysis provider</p>
        <h2>Choose your AI agent</h2>
        <p>Vidmyo sends transcript excerpts to this provider for “Find moments” and “Rank.” Video processing stays local.</p>
      </div>
      <label className="rep-analysis-provider__select">
        <span>AI agent</span>
        <select
          value={selected}
          disabled={busy || Boolean(lockedProvider)}
          onChange={event => saveAnalysisConfig({ analysisProvider: event.target.value || null })}
        >
          <option value="">Choose an agent…</option>
          <option value="openrouter">OpenRouter</option>
          {visibleAgents.map(item => (
            <option key={item.id} value={item.id} disabled={!item.installed && item.id !== lockedProvider}>
              {item.repurposeName || item.name}{item.installed ? '' : ` — ${item.id === 'gemini' ? 'Gemini CLI required' : 'CLI setup required'}`}
            </option>
          ))}
        </select>
      </label>
      {selected === 'openrouter' && (
        <label className="rep-analysis-provider__model">
          <span>OpenRouter model</span>
          <input
            value={lockedModel || config.openRouterModel || ''}
            disabled={busy || Boolean(lockedProvider)}
            placeholder="for example: openai/gpt-5"
            onChange={event => setOpenRouterModel(event.target.value)}
            onBlur={event => saveAnalysisConfig({ openRouterModel: event.target.value || null })}
          />
        </label>
      )}
      <span className={`rep-analysis-provider__status ${selected && ((selected === 'openrouter' && openRouter?.authed) || agent?.authed) ? 'is-ready' : 'is-attention'}`}>{status}</span>
      {lockedProvider && <small>This project is locked to the agent that generated its candidates.</small>}
    </section>
  );
}

export default function RepurposeStudio() {
  const bridge = typeof window !== 'undefined' ? window.repurpose : null;
  const [summary, setSummary] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [config, setConfig] = useState({});
  const [artifacts, setArtifacts] = useState({});
  const [progressByJob, setProgressByJob] = useState({});
  const [activeCandidateId, setActiveCandidateId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [mediaOverride, setMediaOverride] = useState(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [reviewFilter, setReviewFilter] = useState('recommended');
  const [busy, setBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [error, setError] = useState('');
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [form, setForm] = useState({
    sourcePath: '', projectDir: '', requestedClipCount: 5, contentType: 'auto',
    targetPlatforms: ['youtube_shorts'], captionsEnabled: true, captionStyle: 'clean', captionPosition: 'middle',
  });
  const [renderSettings, setRenderSettings] = useState({ projectDir: null, captionsEnabled: true, captionStyle: 'clean', captionPosition: 'middle', captionBackground: true, captionColor: 'preset', captionFont: 'preset', upscaleMode: 'off', platforms: ['youtube_shorts'], separatePlatformFiles: false });
  const [framingSettings, setFramingSettings] = useState({ projectDir: null, mode: 'auto_crop' });

  const loadArtifacts = useCallback(async nextSummary => {
    if (!bridge || !nextSummary?.dir) return;
    const manifest = nextSummary.manifest;
    const requests = {
      candidate: manifest.stages.generate_candidates.artifact,
      boundary: manifest.stages.repair_boundaries.artifact,
      reframeV1: manifest.stages.reframe.state === 'completed' ? 'artifacts/reframe-artifact.v1.json' : null,
      reframeV2: manifest.stages.reframe.artifact,
      render: manifest.stages.render.artifact,
    };
    const entries = await Promise.all(Object.entries(requests).map(async ([key, artifactPath]) => {
      if (!artifactPath) return [key, null];
      const response = await bridge.readArtifact(nextSummary.dir, artifactPath);
      return [key, response.ok ? response.value : null];
    }));
    const loaded = Object.fromEntries(entries);
    setArtifacts(loaded);
    setRenderSettings(current => current.projectDir === nextSummary.dir && !current.restored
      ? { ...settingsFromRenderArtifact(loaded.render, current), restored: true } : current);
    setFramingSettings(current => current.projectDir === nextSummary.dir ? current : {
      projectDir: nextSummary.dir, mode: loaded.reframeV2?.settings?.framing_mode || 'auto_crop',
    });
  }, [bridge]);

  const acceptSummary = useCallback(async next => {
    if (!next?.ok) throw new Error(next?.error || 'The project could not be opened.');
    setSummary(next);
    const captions = captionChoice(next.manifest.render_defaults.captions.style);
    setRenderSettings(current => current.projectDir === next.dir ? current : {
      projectDir: next.dir,
      captionsEnabled: next.manifest.render_defaults.captions.enabled,
      captionStyle: captions.style,
      captionPosition: captions.position,
      captionBackground: captions.background,
      captionColor: 'preset',
      captionFont: 'preset',
      upscaleMode: 'off',
      restored: false,
      platforms: ['youtube_shorts'],
      separatePlatformFiles: false,
    });
    setActiveCandidateId(current => current && next.manifest.candidates.some(item => item.id === current) ? current : next.manifest.candidates[0]?.id || null);
    await loadArtifacts(next);
  }, [loadArtifacts]);

  const refresh = useCallback(async () => {
    if (!bridge || !summary?.dir) return;
    const next = await bridge.get(summary.dir);
    await acceptSummary(next);
  }, [acceptSummary, bridge, summary?.dir]);

  useEffect(() => {
    if (!bridge) return undefined;
    let cancelled = false;
    Promise.all([readRepurposeReadiness(bridge), bridge.getConfig()]).then(async ([ready, stored]) => {
      if (cancelled) return;
      setReadiness(ready);
      if (stored.ok) {
        let nextConfig = stored.config || {};
        const preferred = ready.analysis?.preferredAgent;
        const preferredReady = ready.analysis?.agents?.find(agent => agent.id === preferred && agent.installed);
        if (!nextConfig.analysisProvider && preferredReady) {
          const saved = await bridge.setConfig({ analysisProvider: preferredReady.id });
          if (saved.ok) nextConfig = saved.config;
        }
        if (!cancelled) setConfig(nextConfig);
      }
    }).catch(failure => {
      if (!cancelled) setError(normalizeRepurposeError(failure));
    });
    const unsubscribe = bridge.onProgress(event => {
      setProgressByJob(current => mergeRepurposeProgress(current, event));
      if (['done', 'error', 'cancelled'].includes(event.event)) setTimeout(() => refresh(), 80);
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [bridge, refresh]);

  const activeJob = bestRepurposeJob(summary?.jobs || []);
  useEffect(() => {
    if (!activeJob || !summary?.dir) return undefined;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [activeJob?.id, refresh, summary?.dir]);

  const act = async action => {
    setBusy(true); setError('');
    try { await action(); } catch (actionError) { setError(normalizeRepurposeError(actionError)); }
    finally { setBusy(false); }
  };

  const chooseSource = () => act(async () => {
    const result = await bridge.pickSource();
    if (result.ok) setForm(current => ({ ...current, sourcePath: result.path }));
  });
  const chooseProject = () => act(async () => {
    const result = await bridge.pickProjectDir();
    if (result.ok) setForm(current => ({ ...current, projectDir: result.dir }));
  });
  const openProject = () => act(async () => {
    const picked = await bridge.pickProjectDir();
    if (!picked.ok) return;
    await acceptSummary(await bridge.get(picked.dir));
  });
  const closeProject = () => {
    if (activeJob) {
      setError('Wait for the current stage to finish or cancel it before leaving this project.');
      return;
    }
    setSummary(null);
    setArtifacts({});
    setProgressByJob({});
    setActiveCandidateId(null);
    setPreviewUrl(null);
    setPreviewError('');
    setMediaOverride(null);
    setError('');
    setForm(current => ({ ...current, sourcePath: '', projectDir: '' }));
  };
  const createProject = () => act(async () => {
    const requestedClipCount = Number(form.requestedClipCount);
    if (!Number.isInteger(requestedClipCount) || requestedClipCount < 1 || requestedClipCount > 20) throw new Error('Clips to find must be a whole number from 1 to 20.');
    await acceptSummary(await bridge.create({
      dir: form.projectDir,
      sourcePath: form.sourcePath,
      requestedClipCount,
      contentType: form.contentType,
      targetPlatforms: form.targetPlatforms,
      renderDefaults: { captions: { enabled: form.captionsEnabled, style: captionVariant(form) } },
    }));
  });

  const stages = useMemo(() => deriveRepurposeStages(summary?.manifest, summary?.jobs), [summary]);
  const candidates = useMemo(() => joinRepurposeCandidates(summary?.manifest, artifacts), [summary, artifacts]);
  const visibleCandidates = useMemo(() => reviewCandidates(candidates, reviewFilter), [candidates, reviewFilter]);
  const recommendedCount = candidates.filter(candidate => candidate.metadata?.ranking?.recommended).length;
  const hasRanking = summary?.manifest.stages.rank.state === 'completed';
  const reviewNextStep = repurposeReviewNextStep(summary?.manifest);
  const activeCandidate = visibleCandidates.find(item => item.id === activeCandidateId) || visibleCandidates[0] || null;
  const framingChanged = repurposeFramingChanged(summary?.manifest, artifacts.reframeV2, framingSettings.mode);
  const renderEligibility = framingChanged
    ? { ok: false, candidateIds: [], reason: 'Framing changed. Run Frame vertical again before Finish.' }
    : repurposeRenderEligibility(summary?.manifest, candidates);
  const mediaPath = mediaOverride && mediaOverride.candidateId === activeCandidate?.id ? mediaOverride.path : activeCandidate?.preview?.path;

  useEffect(() => { setReviewFilter('recommended'); setMediaOverride(null); }, [summary?.dir]);

  useEffect(() => {
    let cancelled = false;
    let url = null;
    setPreviewUrl(null); setPreviewError(''); setPreviewBusy(Boolean(mediaPath));
    if (mediaPath && bridge && summary?.dir) {
      Promise.resolve().then(() => bridge.readMedia(summary.dir, mediaPath)).then(result => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error);
        url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
        setPreviewUrl(url);
      }).catch(failure => {
        if (!cancelled) setPreviewError(normalizeRepurposeError(failure));
      }).finally(() => { if (!cancelled) setPreviewBusy(false); });
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [bridge, summary?.dir, activeCandidate?.id, mediaPath, activeCandidate?.preview?.fingerprint, previewRetry]);
  const lockedProvider = artifacts.candidate?.provider?.id || null;
  const lockedModel = artifacts.candidate?.provider?.model || null;
  const analysisProvider = lockedProvider || config.analysisProvider || '';
  const launchBlockReason = (stage, current = readiness) => {
    const runtimeReason = repurposeRuntimeBlockReason(current);
    if (runtimeReason) return runtimeReason;
    const modelReady = Boolean(current?.model?.ok || current?.model?.model_ready || current?.model?.status === 'ready');
    if (stage === 'transcribe' && !modelReady) return 'Point Vidmyo to a cache containing the selected local transcription model.';
    if (!['generate_candidates', 'rank'].includes(stage)) return null;
    const selectedAgent = current?.analysis?.agents?.find(agent => agent.id === analysisProvider);
    return !analysisProvider
    ? 'Choose an AI agent before finding moments.'
    : analysisProvider === 'openrouter'
      ? !(lockedModel || config.openRouterModel)
        ? 'Enter an OpenRouter model before finding moments.'
        : !current?.analysis?.openrouter?.authed
          ? 'Add an OpenRouter key in Settings before finding moments.'
          : null
      : !selectedAgent?.installed
        ? `${selectedAgent?.repurposeName || analysisProvider} CLI is not installed.`
        : !selectedAgent.authed
          ? `${selectedAgent.repurposeName || selectedAgent.name} needs authentication.`
          : null;
  };

  const checkRuntime = async () => {
    const current = await readRepurposeReadiness(bridge);
    setReadiness(current);
    const reason = repurposeRuntimeBlockReason(current);
    if (reason) {
      setReadinessOpen(true);
      throw new Error(reason);
    }
    return current;
  };
  const recheckRuntime = () => act(checkRuntime);

  const runStage = stage => act(async () => {
    const currentReadiness = await checkRuntime();
    const reason = launchBlockReason(stage, currentReadiness);
    if (reason) { setReadinessOpen(true); throw new Error(reason); }
    const options = stage === 'render' ? {
      candidate_ids: renderEligibility.candidateIds,
      captions_enabled: renderSettings.captionsEnabled,
      caption_style: captionVariant(renderSettings),
      caption_color: renderSettings.captionColor,
      caption_font: renderSettings.captionFont,
      platforms: renderSettings.platforms,
      upscale_mode: renderSettings.upscaleMode,
    } : stage === 'reframe' ? { framing_mode: framingSettings.mode } : stage === 'generate_candidates' ? {
      provider: analysisProvider,
      model: analysisProvider === 'openrouter' ? config.openRouterModel : 'configured-default',
    } : {};
    if (stage === 'render' && !renderEligibility.ok) throw new Error(renderEligibility.reason);
    const result = await bridge.runStage(summary.dir, stage, options);
    if (!result.ok) throw new Error(result.error);
    setSummary(current => ({ ...current, jobs: [result.job, ...current.jobs] }));
  });
  const rerunStage = stage => {
    const label = stages.find(item => item.id === stage)?.label || stage;
    if (!confirm(`Run ${label} again?\n\n${RERUN_IMPACT[stage] || 'Later stages may need to run again.'}`)) return;
    runStage(stage);
  };
  const resumeJob = jobId => act(async () => {
    await checkRuntime();
    const result = await bridge.resumeJob(jobId);
    if (!result.ok) throw new Error(result.error);
    await refresh();
  });
  const cancelJob = jobId => act(async () => {
    const result = await bridge.cancelJob(jobId);
    if (!result.ok) throw new Error(result.error);
    await refresh();
  });
  const setDecision = (candidateId, decision) => act(async () => acceptSummary(await bridge.setCandidateDecision(summary.dir, candidateId, decision)));
  const setSelected = (candidateId, selected) => act(async () => acceptSummary(await bridge.selectCandidate(summary.dir, candidateId, selected)));
  const canGeneratePreview = summary?.manifest.stages.rank.state === 'completed';
  const generatePreview = candidateId => act(async () => {
    await checkRuntime();
    if (!canGeneratePreview || activeJob) throw new Error('Finish the current stage before generating a preview.');
    selectCandidate(candidateId);
    const result = await bridge.runStage(summary.dir, 'repair_boundaries', { additional_candidate_ids: [candidateId] });
    if (!result.ok) throw new Error(result.error);
    setSummary(current => ({ ...current, jobs: [result.job, ...current.jobs] }));
  });
  const loadPreview = () => setPreviewRetry(value => value + 1);

  const selectCandidate = id => {
    setPreviewUrl(null); setPreviewError(''); setMediaOverride(null); setActiveCandidateId(id);
  };

  const saveModelConfig = () => act(async () => {
    const result = await bridge.setConfig({
      modelCache: config.modelCache?.trim() || null,
      transcriptionModel: config.transcriptionModel || readiness?.model?.model || 'small',
    });
    if (!result.ok) throw new Error(result.error);
    setConfig(result.config || {});
    const ready = await bridge.readiness();
    if (ready.ok) setReadiness(ready.readiness);
  });
  const setupModel = async () => {
    const modelName = config.transcriptionModel || readiness?.model?.model || 'small';
    if (!confirm(`Download and verify the local ${modelName} transcription model? This is a one-time download.`)) return;
    setSetupBusy(true);
    try {
      await act(async () => {
        const result = await bridge.setupModel();
        if (!result.ok) throw new Error(result.error);
        const ready = await bridge.readiness();
        if (!ready.ok) throw new Error(ready.error);
        setReadiness(ready.readiness);
        setReadinessOpen(false);
      });
    } finally { setSetupBusy(false); }
  };
  const saveAnalysisConfig = update => act(async () => {
    const result = await bridge.setConfig(update);
    if (!result.ok) throw new Error(result.error);
    setConfig(result.config || {});
  });

  if (!bridge?.isElectron) return <DesktopRequired />;
  if (!summary) return <EmptyProject {...{ form, setForm, chooseSource, chooseProject, createProject, openProject, busy, error }} />;

  const sourceName = String(summary.manifest.source.uri || '').split(/[\\/]/).pop();
  const completedCount = stages.filter(stage => stage.manifestState === 'completed').length;
  const finishedCandidates = candidates.filter(candidate => candidate.exports.length);
  return (
    <main className="repurpose-studio rep-workspace">
      <header className="rep-project-head">
        <div>
          <p className="rep-kicker">Clipper / {summary.manifest.id.slice(-8)}</p>
          <h1>{sourceName || 'Untitled recording'}</h1>
          <p className="rep-project-head__path">{summary.dir}</p>
        </div>
        <div className="rep-project-head__meta">
          <span><b>{summary.manifest.requested_clip_count}</b> cuts requested</span>
          <span><b>{completedCount}/7</b> stages complete</span>
          <button onClick={closeProject} disabled={busy || Boolean(activeJob)}><Icon name="x" /> New project</button>
          <button onClick={openProject} disabled={busy || Boolean(activeJob)}><Icon name="folder" /> Open another</button>
        </div>
      </header>

      {error && <div className="rep-alert rep-workspace__alert" role="alert">{error}</div>}
      <AnalysisProviderPanel {...{
        readiness, config, lockedProvider, lockedModel, busy, saveAnalysisConfig,
        setOpenRouterModel: value => setConfig(current => ({ ...current, openRouterModel: value })),
      }} />
      <CutRail {...{ stages, progressByJob, runStage, rerunStage, resumeJob, cancelJob, busy, launchBlockReason }} />

      <div className="rep-workspace__grid">
        <aside className="rep-review-list">
          <div className="rep-panel-head">
            <div><p className="rep-kicker">Review queue</p><h2>{candidates.length ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}` : 'No candidates yet'}</h2></div>
            <span className="rep-timecode">{candidates.filter(item => item.selected).length} selected</span>
          </div>
          <div className="rep-review-filters" role="group" aria-label="Candidate views">
            <button aria-pressed={hasRanking && reviewFilter === 'recommended'} onClick={() => { setActiveCandidateId(activeCandidate?.id || null); setReviewFilter('recommended'); setMediaOverride(null); }} disabled={!hasRanking}>{hasRanking ? `Recommended (${recommendedCount})` : 'Recommended — awaiting Rank'}</button>
            <button aria-pressed={!hasRanking || reviewFilter === 'all'} onClick={() => { setActiveCandidateId(activeCandidate?.id || null); setReviewFilter('all'); setMediaOverride(null); }}>All candidates ({candidates.length})</button>
          </div>
          <div className="rep-review-help">
            <p>{hasRanking ? (recommendedCount ? 'AI recommendations are ready. You can also choose any clip in All candidates.' : 'Rank found no clips meeting the recommendation threshold. You can still approve and select your own.') : 'These moments have not been ranked yet. Run Rank to get AI recommendations; it uses your chosen AI agent.'} Approve a clip, then check Use in render—even before previews are ready.</p>
            {reviewNextStep && <button className="rep-button rep-button--quiet" disabled={busy || Boolean(activeJob)} onClick={() => runStage(reviewNextStep.id)}>{reviewNextStep.id === 'rank' ? 'Rank candidates' : reviewNextStep.id === 'repair_boundaries' ? 'Cut previews for recommendations + selected clips' : 'Frame vertical'} <Icon name="arrow" size={14} /></button>}
          </div>
          <div className="rep-review-list__scroll">
            {!visibleCandidates.length ? <div className="rep-list-empty"><Icon name="film" /><p>{candidates.length ? 'No recommendations yet. Open All candidates to choose your own.' : 'Run “Find moments” to create transcript-grounded candidates.'}</p></div> : visibleCandidates.map(candidate => (
              <CandidateCard key={candidate.id} candidate={candidate} active={candidate.id === activeCandidate?.id} onOpen={() => selectCandidate(candidate.id)} onDecision={decision => setDecision(candidate.id, decision)} onSelect={selected => setSelected(candidate.id, selected)} onGeneratePreview={() => generatePreview(candidate.id)} canGeneratePreview={canGeneratePreview} generating={activeJob?.stage === 'repair_boundaries' && candidate.id === activeCandidateId} disabled={busy || Boolean(activeJob)} />
            ))}
          </div>
        </aside>

        <div className="rep-center">
          <Monitor {...{ candidate: activeCandidate, previewUrl, previewBusy, previewError, loadPreview, generatePreview, canGeneratePreview, busy: busy || Boolean(activeJob) }} />
          <section className="rep-clip-notes">
            <div className="rep-panel-head"><div><p className="rep-kicker">Editorial note</p><h2>{activeCandidate?.metadata?.hook || activeCandidate?.metadata?.title || 'Choose a candidate'}</h2></div>{activeCandidate && <StatusMark state={activeCandidate.decision} />}</div>
            <p>{activeCandidate?.metadata?.selection_reason || activeCandidate?.metadata?.summary || 'Candidate reasoning and transcript evidence will appear here.'}</p>
            {activeCandidate?.metadata?.ranking && <div className="rep-score-row"><span>Clip potential <b>{activeCandidate.metadata.ranking.clip_potential ?? '—'}</b></span><span>Shortlist order <b>{activeCandidate.metadata.ranking.shortlist_order ?? '—'}</b></span><span>Frame mode <b>{activeCandidate.reframeV2?.mode?.replaceAll('_', ' ') || '—'}</b></span></div>}
          </section>
        </div>

        <aside className="rep-delivery">
          <ReadinessPanel readiness={readiness} config={config} setModelCache={value => setConfig(current => ({ ...current, modelCache: value }))} setTranscriptionModel={value => setConfig(current => ({ ...current, transcriptionModel: value }))} saveModelConfig={saveModelConfig} setupModel={setupModel} recheckRuntime={recheckRuntime} busy={busy} setupBusy={setupBusy} open={readinessOpen} onToggle={setReadinessOpen} />
          <section className="rep-delivery__card">
            <p className="rep-kicker">Finish settings</p><h2>Local exports</h2>
            <label className="rep-delivery__select"><span>Vertical framing</span><select value={framingSettings.mode} onChange={event => setFramingSettings(current => ({ ...current, mode: event.target.value }))} disabled={busy || Boolean(activeJob)}><option value="auto_crop">Auto crop · follow speakers</option><option value="stack_sides">Stack left + right</option><option value="fit_full">Fit full frame · black bars</option></select></label>
            <p className="rep-delivery__hint">{framingSettings.mode === 'fit_full' ? 'Keeps the whole picture centered in 9:16, with black space above and below a horizontal video for your notes. Notes are not added automatically.' : framingSettings.mode === 'stack_sides' ? 'Splits a side-by-side source down the middle, placing the left side above the right side. Best for two people or two important views already arranged left and right.' : 'Crops to follow the speaker, with two-speaker layouts when suitable.'} Choose a layout, then run Frame vertical.</p>
            {framingChanged && <button className="rep-button rep-button--quiet" disabled={busy || Boolean(activeJob)} onClick={() => rerunStage('reframe')}>Apply framing · run Frame vertical</button>}
            <label className="rep-delivery__toggle"><input type="checkbox" checked={renderSettings.captionsEnabled} onChange={event => setRenderSettings(current => ({ ...current, captionsEnabled: event.target.checked }))} disabled={busy || Boolean(activeJob)} /><span>Burn in captions</span></label>
            <CaptionStudio settings={renderSettings} onChange={setRenderSettings} disabled={busy || Boolean(activeJob) || !renderSettings.captionsEnabled} previewUrl={mediaOverride ? null : previewUrl} />
            <div className="rep-upscale">
              <p className="rep-kicker">Resolution & upscaling <span>LOCAL</span></p>
              <label className="rep-delivery__select"><span>Export resolution</span><select aria-label="Export resolution" value={renderSettings.upscaleMode === 'off' ? 'off' : '4k'} onChange={event => setRenderSettings(current => ({ ...current, upscaleMode: event.target.value === 'off' ? 'off' : 'lanczos_4k_sharp' }))} disabled={busy || Boolean(activeJob)}><option value="off">1080 × 1920</option><option value="4k">4K · 2160 × 3840</option></select></label>
              {renderSettings.upscaleMode !== 'off' && <label className="rep-delivery__toggle"><input type="checkbox" checked={renderSettings.upscaleMode === 'lanczos_4k_sharp'} onChange={event => setRenderSettings(current => ({ ...current, upscaleMode: event.target.checked ? 'lanczos_4k_sharp' : 'lanczos_4k' }))} disabled={busy || Boolean(activeJob)} /><span>Gentle sharpening</span></label>}
              <p className="rep-delivery__hint">{renderSettings.upscaleMode === 'off' ? 'Original vertical output. Choose 4K to upscale selected clips—even ones you already finished.' : '2× Lanczos upscale, not AI restoration. Cannot recover missing source detail. Larger files and slower exports. Your original 1080p files stay on disk.'}</p>
            </div>
            <fieldset className="rep-delivery__targets"><legend>Output files</legend>
              <label><input type="radio" name="output-files" checked={!renderSettings.separatePlatformFiles} onChange={() => setRenderSettings(current => ({ ...current, separatePlatformFiles: false, platforms: ['youtube_shorts'] }))} disabled={busy || Boolean(activeJob)} /><span>One universal MP4</span></label>
              <label><input type="radio" name="output-files" checked={renderSettings.separatePlatformFiles} onChange={() => setRenderSettings(current => ({ ...current, separatePlatformFiles: true, platforms: PLATFORMS.map(([id]) => id) }))} disabled={busy || Boolean(activeJob)} /><span>Separate platform files</span></label>
            </fieldset>
            <p className="rep-delivery__hint">One universal 9:16 MP4 works on Shorts, TikTok, and Reels. Separate files create three versions per selected clip.</p>
            <p className="rep-delivery__hint">{renderEligibility.ok ? `${renderEligibility.candidateIds.length} approved clip${renderEligibility.candidateIds.length === 1 ? '' : 's'} ready to finish.` : renderEligibility.reason}</p>
            <button className="rep-button rep-button--primary rep-setup__submit" onClick={() => runStage('render')} disabled={busy || Boolean(activeJob) || !renderEligibility.ok}>{summary.manifest.stages.render.state === 'completed' ? 'Render again with these settings' : 'Finish selected clips'} <Icon name="arrow" /></button>
          </section>
          <section className="rep-exports">
            <div className="rep-panel-head"><div><p className="rep-kicker">Delivery shelf</p><h2>{finishedCandidates.length ? `${finishedCandidates.length} finished clip${finishedCandidates.length === 1 ? '' : 's'}` : 'Nothing rendered'}</h2></div></div>
            <div className="rep-exports__list">
              {finishedCandidates.map(candidate => {
                const entry = candidate.exports.find(item => item.preset_id === 'youtube_shorts') || candidate.exports[0];
                return (
                <article key={candidate.id}>
                  <span className="rep-export__icon"><Icon name="film" /></span>
                  <span><b>{candidate.metadata?.title || candidate.id}</b><small>{candidate.exports.length === 1 ? 'Universal MP4' : `${candidate.exports.length} platform files`} · {entry.output?.width}×{entry.output?.height}</small></span>
                  <button onClick={() => { setReviewFilter('all'); setActiveCandidateId(candidate.id); setMediaOverride({ candidateId: candidate.id, path: entry.output.path }); }} aria-label={`Play ${candidate.id} ${entry.preset_id}`}><Icon name="play" /></button>
                  <button onClick={() => bridge.reveal(summary.dir, entry.output.path)} aria-label={`Show ${candidate.id} ${entry.preset_id} in folder`}><Icon name="reveal" /></button>
                </article>
              )})}
              {!summary.manifest.outputs.length && <p>Finished platform files stay here on this computer.</p>}
              {summary.manifest.outputs.length > 0 && !candidates.some(candidate => candidate.exports.length) && <p>Earlier exports are preserved. Finish again for the updated selection. <button onClick={() => bridge.reveal(summary.dir, summary.manifest.outputs[0])}>Show earlier exports</button></p>}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
