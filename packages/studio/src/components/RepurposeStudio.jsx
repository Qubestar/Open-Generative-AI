"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  bestRepurposeJob,
  deriveRepurposeStages,
  formatRepurposeDuration,
  joinRepurposeCandidates,
  mergeRepurposeProgress,
  normalizeRepurposeError,
  repurposeRenderEligibility,
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
      <h1>Repurpose runs in the Vidmyo desktop app.</h1>
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
        <p className="rep-kicker">Repurpose / local beta</p>
        <h1>Find the cuts worth keeping.</h1>
        <p>Turn one long recording into reviewed vertical clips. Analysis, previews, captions, and exports stay on this computer.</p>
        <div className="rep-empty-state__rail" aria-hidden="true">
          <span>Long recording</span><i /><i /><i /><strong>Selected cuts</strong>
        </div>
        <button className="rep-button rep-button--quiet" onClick={openProject} disabled={busy}>
          <Icon name="folder" /> Open an existing project
        </button>
      </section>

      <section className="rep-setup" aria-label="Create a Repurpose project">
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
          <label><span>Caption treatment</span><select value={form.captionStyle} onChange={event => setForm(current => ({ ...current, captionStyle: event.target.value }))}><option value="clean">Clean</option><option value="bold">Bold</option></select></label>
        </div>
        <fieldset className="rep-platforms"><legend>Delivery formats</legend>{PLATFORMS.map(([id, label]) => <label key={id}><input type="checkbox" checked={form.targetPlatforms.includes(id)} onChange={() => togglePlatform(id)} /><span>{label}</span></label>)}</fieldset>
        <label className="rep-switch"><input type="checkbox" checked={form.captionsEnabled} onChange={event => setForm(current => ({ ...current, captionsEnabled: event.target.checked }))} /><span>Render captions on finished clips</span></label>
        <button className="rep-button rep-button--primary rep-setup__submit" onClick={createProject} disabled={busy || !form.sourcePath || !form.projectDir || !form.targetPlatforms.length}>
          {busy ? 'Creating project…' : 'Create project'} <Icon name="arrow" />
        </button>
      </section>
    </main>
  );
}

function CutRail({ stages, progressByJob, runStage, resumeJob, cancelJob, busy, launchBlockReason }) {
  return (
    <section className="rep-cut-rail" aria-label="Repurpose stages">
      <div className="rep-cut-rail__line" aria-hidden="true" />
      {stages.map(stage => {
        const blockReason = launchBlockReason(stage.id);
        const liveProgress = stage.job ? progressByJob[stage.job.id] : null;
        const fraction = Number(liveProgress?.payload?.fraction ?? stage.progress?.fraction);
        const percent = Number.isFinite(fraction) ? Math.max(0, Math.min(100, Math.round(fraction * 100))) : null;
        return (
          <article key={stage.id} className={`rep-stage rep-stage--${stage.state}${stage.runnable ? ' is-runnable' : ''}`}>
            <button
              className="rep-stage__head"
              onClick={() => stage.runnable && !blockReason ? runStage(stage.id) : stage.resumable ? resumeJob(stage.job.id) : undefined}
              disabled={busy || (!stage.runnable && !stage.resumable) || (stage.runnable && Boolean(blockReason))}
              title={stage.runnable && blockReason ? blockReason : undefined}
              aria-label={`${stage.label}: ${stage.state}${stage.runnable ? '. Run stage' : stage.resumable ? '. Resume stage' : ''}`}
            >
              <span className="rep-stage__number">{String(stage.index + 1).padStart(2, '0')}</span>
              <span className="rep-stage__node">{stage.state === 'completed' ? <Icon name="check" size={14} /> : stage.state === 'running' || stage.state === 'queued' ? <span className="rep-pulse" /> : null}</span>
              <span className="rep-stage__copy"><b>{stage.label}</b><small>{stage.runnable && blockReason ? 'Setup required' : stage.runnable ? 'Ready — click to run' : stage.state === 'blocked' ? 'Waiting' : stage.state}</small></span>
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

function CandidateCard({ candidate, active, onOpen, onDecision, onSelect, disabled }) {
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
      <div className="rep-candidate__actions" aria-label={`Review ${candidate.id}`}>
        <button className={candidate.decision === 'approved' ? 'is-approved' : ''} onClick={() => onDecision('approved')} disabled={disabled}><Icon name="check" size={14} /> Approve</button>
        <button className={candidate.decision === 'rejected' ? 'is-rejected' : ''} onClick={() => onDecision('rejected')} disabled={disabled}><Icon name="x" size={14} /> Reject</button>
        <label className={candidate.selected ? 'is-selected' : ''}><input type="checkbox" checked={candidate.selected} onChange={event => onSelect(event.target.checked)} disabled={disabled || candidate.decision !== 'approved'} />Use in render</label>
      </div>
    </article>
  );
}

function Monitor({ candidate, previewUrl, previewBusy, previewError, loadPreview }) {
  return (
    <section className="rep-monitor" aria-label="Clip monitor">
      <div className="rep-monitor__screen">
        {previewUrl ? <video src={previewUrl} controls playsInline aria-label={`Preview ${candidate?.id || ''}`} /> : (
          <div className="rep-monitor__placeholder">
            <span className="rep-monitor__safe" />
            <div className="rep-monitor__play"><Icon name="play" size={24} /></div>
            <p>{previewBusy ? 'Loading local preview…' : candidate?.preview ? 'Preview ready on this computer' : 'A preview appears after the cut stage.'}</p>
            {candidate?.preview && !previewBusy && <button onClick={loadPreview}>Load preview</button>}
          </div>
        )}
      </div>
      <div className="rep-monitor__strip">
        <span className="rep-timecode">{candidate ? candidate.id.toUpperCase() : 'NO CLIP'}</span>
        <span>{candidate?.reframeV2?.mode?.replaceAll('_', ' ') || candidate?.reframeV1?.mode || '9:16 monitor'}</span>
        <span>{candidate?.preview ? 'Local preview' : 'Waiting for media'}</span>
      </div>
      {previewError && <p className="rep-monitor__error" role="alert">{previewError}</p>}
    </section>
  );
}

function ReadinessPanel({ readiness, config, setModelCache, saveModelCache }) {
  const checks = [
    ['Python', readiness?.python?.ok],
    ['Engine', readiness?.engine?.ok],
    ['FFmpeg', readiness?.ffmpeg?.ok],
    ['FFprobe', readiness?.ffprobe?.ok],
  ];
  const modelReady = Boolean(readiness?.model?.ok || readiness?.model?.model_ready || readiness?.model?.status === 'ready');
  return (
    <details className="rep-readiness">
      <summary><Icon name="settings" size={15} /><span>Local setup</span><StatusMark state={readiness?.ok ? (modelReady ? 'ready' : 'attention') : 'blocked'} /></summary>
      <div className="rep-readiness__body">
        <div className="rep-readiness__checks">{checks.map(([name, ok]) => <span key={name} className={ok ? 'is-ok' : 'is-missing'}>{ok ? '✓' : '×'} {name}</span>)}</div>
        <p>{modelReady ? 'The local transcription model is ready.' : 'Runtime is available, but the transcription model is not cached. Vidmyo will not download it automatically.'}</p>
        <label><span>Model cache folder</span><input value={config.modelCache || ''} onChange={event => setModelCache(event.target.value)} placeholder="Absolute path to an existing model cache" /></label>
        <button onClick={saveModelCache}>Save cache location</button>
      </div>
    </details>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    sourcePath: '', projectDir: '', requestedClipCount: 5, contentType: 'auto',
    targetPlatforms: ['youtube_shorts', 'tiktok', 'instagram_reels'], captionsEnabled: true, captionStyle: 'clean',
  });
  const [renderSettings, setRenderSettings] = useState({ projectDir: null, captionsEnabled: true, captionStyle: 'clean', platforms: [] });

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
    setArtifacts(Object.fromEntries(entries));
  }, [bridge]);

  const acceptSummary = useCallback(async next => {
    if (!next?.ok) throw new Error(next?.error || 'The project could not be opened.');
    setSummary(next);
    setRenderSettings(current => current.projectDir === next.dir ? current : {
      projectDir: next.dir,
      captionsEnabled: next.manifest.render_defaults.captions.enabled,
      captionStyle: next.manifest.render_defaults.captions.style,
      platforms: [...next.manifest.target_platforms],
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
    Promise.all([bridge.readiness(), bridge.getConfig()]).then(([ready, stored]) => {
      if (cancelled) return;
      if (ready.ok) setReadiness(ready.readiness);
      if (stored.ok) setConfig(stored.config || {});
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

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

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
  const createProject = () => act(async () => {
    const requestedClipCount = Number(form.requestedClipCount);
    if (!Number.isInteger(requestedClipCount) || requestedClipCount < 1 || requestedClipCount > 20) throw new Error('Clips to find must be a whole number from 1 to 20.');
    await acceptSummary(await bridge.create({
      dir: form.projectDir,
      sourcePath: form.sourcePath,
      requestedClipCount,
      contentType: form.contentType,
      targetPlatforms: form.targetPlatforms,
      renderDefaults: { captions: { enabled: form.captionsEnabled, style: form.captionStyle } },
    }));
  });

  const stages = useMemo(() => deriveRepurposeStages(summary?.manifest, summary?.jobs), [summary]);
  const candidates = useMemo(() => joinRepurposeCandidates(summary?.manifest, artifacts), [summary, artifacts]);
  const activeCandidate = candidates.find(item => item.id === activeCandidateId) || candidates[0] || null;
  const renderEligibility = repurposeRenderEligibility(summary?.manifest);
  const runtimeBlocked = !readiness || !readiness.ok;
  const modelReady = Boolean(readiness?.model?.ok || readiness?.model?.model_ready || readiness?.model?.status === 'ready');
  const launchBlockReason = stage => runtimeBlocked
    ? 'Complete the missing local runtime setup before starting this stage.'
    : stage === 'transcribe' && !modelReady
      ? 'Point Vidmyo to a cache containing the local small transcription model.'
      : null;

  const runStage = stage => act(async () => {
    if (launchBlockReason(stage)) throw new Error(launchBlockReason(stage));
    const options = stage === 'render' ? {
      candidate_ids: renderEligibility.candidateIds,
      captions_enabled: renderSettings.captionsEnabled,
      caption_style: renderSettings.captionStyle,
      platforms: renderSettings.platforms,
    } : {};
    if (stage === 'render' && !renderEligibility.ok) throw new Error(renderEligibility.reason);
    const result = await bridge.runStage(summary.dir, stage, options);
    if (!result.ok) throw new Error(result.error);
    setSummary(current => ({ ...current, jobs: [result.job, ...current.jobs] }));
  });
  const resumeJob = jobId => act(async () => {
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

  const loadMedia = mediaPath => act(async () => {
    if (!mediaPath) throw new Error('This clip does not have playable local media yet.');
    setPreviewBusy(true); setPreviewError('');
    try {
      const result = await bridge.readMedia(summary.dir, mediaPath);
      if (!result.ok) throw new Error(result.error);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(new Blob([result.bytes], { type: result.mime })));
    } catch (previewFailure) {
      setPreviewError(normalizeRepurposeError(previewFailure));
    } finally { setPreviewBusy(false); }
  });
  const loadPreview = () => loadMedia(activeCandidate?.preview?.path);

  const selectCandidate = id => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null); setPreviewError(''); setActiveCandidateId(id);
  };

  const saveModelCache = () => act(async () => {
    const result = await bridge.setConfig({ modelCache: config.modelCache?.trim() || null });
    if (!result.ok) throw new Error(result.error);
    setConfig(result.config || {});
    const ready = await bridge.readiness();
    if (ready.ok) setReadiness(ready.readiness);
  });

  if (!bridge?.isElectron) return <DesktopRequired />;
  if (!summary) return <EmptyProject {...{ form, setForm, chooseSource, chooseProject, createProject, openProject, busy, error }} />;

  const sourceName = String(summary.manifest.source.uri || '').split(/[\\/]/).pop();
  const completedCount = stages.filter(stage => stage.manifestState === 'completed').length;
  return (
    <main className="repurpose-studio rep-workspace">
      <header className="rep-project-head">
        <div>
          <p className="rep-kicker">Repurpose / {summary.manifest.id.slice(-8)}</p>
          <h1>{sourceName || 'Untitled recording'}</h1>
          <p className="rep-project-head__path">{summary.dir}</p>
        </div>
        <div className="rep-project-head__meta">
          <span><b>{summary.manifest.requested_clip_count}</b> cuts requested</span>
          <span><b>{completedCount}/7</b> stages complete</span>
          <button onClick={openProject} disabled={busy}><Icon name="folder" /> Switch project</button>
        </div>
      </header>

      {error && <div className="rep-alert rep-workspace__alert" role="alert">{error}</div>}
      <CutRail {...{ stages, progressByJob, runStage, resumeJob, cancelJob, busy, launchBlockReason }} />

      <div className="rep-workspace__grid">
        <aside className="rep-review-list">
          <div className="rep-panel-head">
            <div><p className="rep-kicker">Review queue</p><h2>{candidates.length ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}` : 'No candidates yet'}</h2></div>
            <span className="rep-timecode">{candidates.filter(item => item.selected).length} selected</span>
          </div>
          <div className="rep-review-list__scroll">
            {!candidates.length ? <div className="rep-list-empty"><Icon name="film" /><p>Run “Find moments” to create transcript-grounded candidates.</p></div> : candidates.map(candidate => (
              <CandidateCard key={candidate.id} candidate={candidate} active={candidate.id === activeCandidate?.id} onOpen={() => selectCandidate(candidate.id)} onDecision={decision => setDecision(candidate.id, decision)} onSelect={selected => setSelected(candidate.id, selected)} disabled={busy || Boolean(activeJob)} />
            ))}
          </div>
        </aside>

        <div className="rep-center">
          <Monitor {...{ candidate: activeCandidate, previewUrl, previewBusy, previewError, loadPreview }} />
          <section className="rep-clip-notes">
            <div className="rep-panel-head"><div><p className="rep-kicker">Editorial note</p><h2>{activeCandidate?.metadata?.hook || activeCandidate?.metadata?.title || 'Choose a candidate'}</h2></div>{activeCandidate && <StatusMark state={activeCandidate.decision} />}</div>
            <p>{activeCandidate?.metadata?.selection_reason || activeCandidate?.metadata?.summary || 'Candidate reasoning and transcript evidence will appear here.'}</p>
            {activeCandidate?.metadata?.ranking && <div className="rep-score-row"><span>Clip potential <b>{activeCandidate.metadata.ranking.clip_potential ?? '—'}</b></span><span>Shortlist order <b>{activeCandidate.metadata.ranking.shortlist_order ?? '—'}</b></span><span>Frame mode <b>{activeCandidate.reframeV2?.mode?.replaceAll('_', ' ') || '—'}</b></span></div>}
          </section>
        </div>

        <aside className="rep-delivery">
          <ReadinessPanel readiness={readiness} config={config} setModelCache={value => setConfig(current => ({ ...current, modelCache: value }))} saveModelCache={saveModelCache} />
          <section className="rep-delivery__card">
            <p className="rep-kicker">Finish settings</p><h2>Local exports</h2>
            <label className="rep-delivery__toggle"><input type="checkbox" checked={renderSettings.captionsEnabled} onChange={event => setRenderSettings(current => ({ ...current, captionsEnabled: event.target.checked }))} disabled={busy || Boolean(activeJob)} /><span>Burn in captions</span></label>
            <label className="rep-delivery__select"><span>Caption treatment</span><select value={renderSettings.captionStyle} onChange={event => setRenderSettings(current => ({ ...current, captionStyle: event.target.value }))} disabled={busy || Boolean(activeJob) || !renderSettings.captionsEnabled}><option value="clean">Clean</option><option value="bold">Bold</option></select></label>
            <fieldset className="rep-delivery__targets"><legend>Delivery formats</legend>{PLATFORMS.map(([platform, label]) => <label key={platform}><input type="checkbox" checked={renderSettings.platforms.includes(platform)} onChange={() => setRenderSettings(current => ({ ...current, platforms: current.platforms.includes(platform) ? current.platforms.filter(item => item !== platform) : [...current.platforms, platform] }))} disabled={busy || Boolean(activeJob) || (renderSettings.platforms.length === 1 && renderSettings.platforms[0] === platform)} /><span>{label}</span></label>)}</fieldset>
            <p className="rep-delivery__hint">{renderEligibility.ok ? `${renderEligibility.candidateIds.length} approved clip${renderEligibility.candidateIds.length === 1 ? '' : 's'} ready to finish.` : renderEligibility.reason}</p>
          </section>
          <section className="rep-exports">
            <div className="rep-panel-head"><div><p className="rep-kicker">Delivery shelf</p><h2>{summary.manifest.outputs.length ? `${summary.manifest.outputs.length} exports` : 'Nothing rendered'}</h2></div></div>
            <div className="rep-exports__list">
              {candidates.flatMap(candidate => candidate.exports.map(entry => ({ candidate, entry }))).map(({ candidate, entry }) => (
                <article key={`${candidate.id}-${entry.preset_id}`}>
                  <span className="rep-export__icon"><Icon name="film" /></span>
                  <span><b>{candidate.metadata?.title || candidate.id}</b><small>{PLATFORMS.find(([id]) => id === entry.preset_id)?.[1] || entry.preset_id} · {entry.output?.width}×{entry.output?.height}</small></span>
                  <button onClick={() => { selectCandidate(candidate.id); loadMedia(entry.output.path); }} aria-label={`Play ${candidate.id} ${entry.preset_id}`}><Icon name="play" /></button>
                  <button onClick={() => bridge.reveal(summary.dir, entry.output.path)} aria-label={`Show ${candidate.id} ${entry.preset_id} in folder`}><Icon name="reveal" /></button>
                </article>
              ))}
              {!summary.manifest.outputs.length && <p>Finished platform files stay here on this computer.</p>}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
