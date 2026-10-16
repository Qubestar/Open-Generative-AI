import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHANNEL_QUEUE_GROUPS,
  CHANNEL_CREATION_MODES,
  channelDraft,
  channelInputFromDraft,
  channelVideos,
  durationLabel,
  groupedChannelVideos,
  nextReadyChannelVideo,
  readyChannelVideos,
  videoDraft,
  videoInputFromDraft,
  researchInputFromDraft,
  plannerInputFromDraft,
  normalizeAnalysis,
  normalizePlanItems,
} from '../channelStudioModel.mjs';
import './ChannelsStudio.css';

const EMPTY_DRAFT = channelDraft();

function defaultAnalyticsRange() {
  const end = new Date();
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function bridgeFromWindow() {
  return typeof window !== 'undefined' && window.channels?.isElectron ? window.channels : null;
}

function errorText(value, fallback = 'Something went wrong. Try again.') {
  return typeof value === 'string' ? value : value?.message || fallback;
}

function recentsFromResponse(response) {
  const items = response?.channels || response?.items || response?.recent || [];
  return Array.isArray(items) ? items.filter(item => item?.dir) : [];
}

function statusLabel(status) {
  return String(status || 'ready').replace(/-/g, ' ');
}

function blankVideoDraft(channel) {
  return videoDraft({}, channel);
}

function Field({ label, hint, children }) {
  return <label className="channels-field"><span className="channels-label">{label}{hint && <span className="channels-hint">{hint}</span>}</span>{children}</label>;
}

function ChannelForm({ draft, onChange, disabled }) {
  const set = (field, value) => onChange(current => ({ ...current, [field]: value }));
  const mode = draft.sourceMode || 'niche';
  const urls = draft.exampleUrls || ['', ''];
  return (
    <>
    <div className="channels-source-modes" role="radiogroup" aria-label="Channel starting point">
      {CHANNEL_CREATION_MODES.map(item => <label key={item.id} className={`channels-source-mode ${mode === item.id ? 'is-selected' : ''}`}><input type="radio" name="channel-source-mode" value={item.id} checked={mode === item.id} onChange={event => set('sourceMode', event.target.value)} disabled={disabled} /><span><strong>{item.label}</strong><small>{item.id === 'existing' ? 'Review one public profile.' : item.id === 'examples' ? 'Learn from up to three public references.' : 'Shape a strategy around your niche.'}</small></span></label>)}
    </div>
    {mode === 'existing' && <Field label="YouTube channel URL"><input className="channels-input" value={draft.profileUrl} onChange={event => set('profileUrl', event.target.value)} disabled={disabled} placeholder="https://www.youtube.com/@channel" /></Field>}
    {mode === 'examples' && <div className="channels-reference-fields">{urls.map((url, index) => <Field key={index} label={`Example channel ${index + 1}`} hint={index === 0 ? 'required' : 'optional'}><input className="channels-input" value={url} onChange={event => onChange(current => ({ ...current, exampleUrls: current.exampleUrls.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} disabled={disabled} placeholder="https://www.youtube.com/@example" /></Field>)}</div>}
    <div className="channels-form-grid">
      <Field label="Channel name"><input className="channels-input" autoFocus value={draft.name} onChange={event => set('name', event.target.value)} disabled={disabled} placeholder="For example, Curious World" /></Field>
      <Field label="Language"><input className="channels-input" value={draft.language} onChange={event => set('language', event.target.value)} disabled={disabled} placeholder="English" /></Field>
      <Field label="Audience"><input className="channels-input" value={draft.audience} onChange={event => set('audience', event.target.value)} disabled={disabled} placeholder="Who is this for?" /></Field>
      <Field label="Positioning"><input className="channels-input" value={draft.positioning} onChange={event => set('positioning', event.target.value)} disabled={disabled} placeholder="A clear promise for viewers" /></Field>
      <Field label="Default workspace"><select className="channels-input" value={draft.kind} onChange={event => set('kind', event.target.value)} disabled={disabled}><option value="story">Stickman</option><option value="animation">Animations</option></select></Field>
      <Field label="Visual style"><input className="channels-input" value={draft.style} onChange={event => set('style', event.target.value)} disabled={disabled} placeholder="doodle-v1" /></Field>
      <Field label="Aspect ratio"><select className="channels-input" value={draft.aspect} onChange={event => set('aspect', event.target.value)} disabled={disabled}><option value="16:9">Landscape · 16:9</option><option value="9:16">Vertical · 9:16</option></select></Field>
      <Field label="Target duration"><input className="channels-input" type="number" min="5" max="900" value={draft.durationSec} onChange={event => set('durationSec', event.target.value)} disabled={disabled} /><span className="channels-unit">seconds</span></Field>
      <Field label="Niche"><input className="channels-input" value={draft.niche} onChange={event => set('niche', event.target.value)} disabled={disabled} placeholder="What should this channel explore?" /></Field>
      <Field label="Goals"><textarea className="channels-textarea" value={draft.goals} onChange={event => set('goals', event.target.value)} disabled={disabled} placeholder="What would make the first slate useful?" /></Field>
    </div>
    </>
  );
}

function VideoForm({ draft, channel, onChange, disabled }) {
  const set = (field, value) => onChange(current => ({ ...current, [field]: value }));
  const defaults = channel.defaults || {};
  return <div className="channels-video-form">
    <Field label="Working title"><input className="channels-input" value={draft.title} onChange={event => set('title', event.target.value)} disabled={disabled} placeholder="What will the viewer click?" /></Field>
    <Field label="Opening hook"><textarea className="channels-textarea" value={draft.hook} onChange={event => set('hook', event.target.value)} disabled={disabled} placeholder="The first thought that earns attention" /></Field>
    <div className="channels-form-grid compact">
      <Field label="Topic / angle"><input className="channels-input" value={draft.angle} onChange={event => set('angle', event.target.value)} disabled={disabled} placeholder="The specific promise" /></Field>
      <Field label="Content pillar"><input className="channels-input" value={draft.pillar} onChange={event => set('pillar', event.target.value)} disabled={disabled} placeholder="Optional" /></Field>
      <Field label="Workspace"><select className="channels-input" value={draft.kind} onChange={event => set('kind', event.target.value)} disabled={disabled}><option value="story">Stickman</option><option value="animation">Animations</option></select></Field>
      <Field label="Style"><input className="channels-input" value={draft.style} onChange={event => set('style', event.target.value)} disabled={disabled} placeholder={defaults.style || 'Style'} /></Field>
      <Field label="Priority"><input className="channels-input" type="number" min="0" max="100" value={draft.priority} onChange={event => set('priority', event.target.value)} disabled={disabled} /></Field>
    </div>
  </div>;
}

function QueueRow({ video, onChoose, onEdit, onArchive, busy }) {
  return <tr>
    <td className="channels-sequence">{video.sequence || '—'}</td>
    <td><strong>{video.title}</strong>{video.hook && <span className="channels-row-copy">{video.hook}</span>}{video.angle && <span className="channels-row-angle">{video.angle}</span>}</td>
    <td><span className="channels-kind">{video.kind === 'animation' ? 'Animations' : 'Stickman'}</span>{video.style && <span className="channels-row-copy">{video.style}</span>}</td>
    <td><span className="channels-priority">{video.priority}</span></td>
    <td><span className={`channels-status channels-status-${video.status}`}>{statusLabel(video.status)}</span></td>
    <td><div className="channels-row-actions">
      {video.status === 'ready' && <button type="button" className="channels-button channels-button-small" disabled={!!busy} onClick={() => onChoose(video)}>{busy === `choose-${video.id}` ? 'Choosing…' : 'Choose'}</button>}
      {video.status !== 'archived' && <button type="button" className="channels-button channels-button-small channels-button-quiet" disabled={!!busy} onClick={() => onEdit(video)}>Edit</button>}
      {video.status !== 'archived' && <button type="button" className="channels-icon-button" aria-label={`Archive ${video.title}`} title="Archive idea" disabled={!!busy} onClick={() => onArchive(video)}>Archive</button>}
    </div></td>
  </tr>;
}

function AnalysisCard({ analysis }) {
  const profile = analysis?.profile || {};
  return <section className="channels-analysis" aria-label="Public profile analysis"><div className="channels-card-heading"><div><h3>Public profile snapshot</h3><p>Evidence from the supplied public channel references.</p></div></div><div className="channels-analysis-profile"><strong>{profile.name || profile.title || 'Profile'}</strong>{profile.description && <span>{profile.description}</span>}{profile.url && <a href={profile.url} target="_blank" rel="noreferrer">Open source</a>}</div>{analysis.evidence.length > 0 && <div className="channels-evidence"><strong>Evidence</strong><ul>{analysis.evidence.map((item, index) => <li key={index}>{typeof item === 'string' ? item : item.text || item.label || JSON.stringify(item)}</li>)}</ul></div>}{analysis.opportunities.length > 0 && <div className="channels-opportunities"><strong>Possible opportunities</strong><ul>{analysis.opportunities.map((item, index) => <li key={index}>{typeof item === 'string' ? item : item.text || item.label || JSON.stringify(item)}</li>)}</ul></div>}</section>;
}

function PlannerCard({ planner, setPlanner, planItems, setPlanItems, busy, onGenerate, onAddSelected, agents, agentsLoaded }) {
  const set = (field, value) => setPlanner(current => ({ ...current, [field]: value }));
  const refs = planner.referenceUrls || ['', ''];
  const provider = planner.provider || 'agent';
  return <section className="channels-card channels-planner" aria-labelledby="planner-title"><div className="channels-card-heading"><div><h2 id="planner-title">Draft a 10 or 20 video plan</h2><p>Set the goal, niche, and optional public references. Review every proposal before it enters Ready.</p></div><span className="channels-coming">Editable draft</span></div><form onSubmit={onGenerate}><div className="channels-form-grid compact"><Field label="Choice count"><select className="channels-input" value={planner.count} onChange={event => set('count', event.target.value)} disabled={!!busy}><option value="10">10 videos</option><option value="20">20 videos</option></select></Field><Field label="Responsible agent"><select className="channels-input" value={provider === 'api' ? 'api' : planner.agentId || ''} onChange={event => { const value = event.target.value; setPlanner(current => ({ ...current, provider: value === 'api' ? 'api' : 'agent', agentId: value === 'api' ? 'openrouter' : value, model: value === 'api' ? current.model : '' })); }} disabled={!!busy || (!agentsLoaded && !agents.length)}><option value="">{agentsLoaded ? 'Choose installed agent' : 'Detecting agents…'}</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name || agent.id}{agent.installed === false ? ' · not installed' : ''}</option>)}<option value="api">API model</option></select></Field><Field label={provider === 'api' ? 'API model' : 'Agent model'}><input className="channels-input" value={planner.model || ''} onChange={event => set('model', event.target.value)} disabled={!!busy} placeholder={provider === 'api' ? 'provider/model-id' : 'Automatic (recommended)'} /></Field><Field label="Niche"><input className="channels-input" value={planner.niche} onChange={event => set('niche', event.target.value)} disabled={!!busy} placeholder="Topic or audience" /></Field><Field label="Goals"><input className="channels-input" value={planner.goals} onChange={event => set('goals', event.target.value)} disabled={!!busy} placeholder="What should the slate achieve?" /></Field></div><div className="channels-reference-fields">{refs.map((url, index) => <Field key={index} label={`Reference ${index + 1}`} hint="optional"><input className="channels-input" value={url} onChange={event => setPlanner(current => ({ ...current, referenceUrls: current.referenceUrls.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} disabled={!!busy} placeholder="https://www.youtube.com/@reference" /></Field>)}</div><div className="channels-form-actions"><button type="submit" className="channels-button channels-button-primary" disabled={!!busy || !planner.niche.trim() || (provider !== 'api' && !planner.agentId)}>{busy === 'plan' ? 'Generating…' : 'Generate draft'}</button></div></form>{planItems.length > 0 && <div className="channels-proposal-list"><div className="channels-proposal-toolbar"><strong>{planItems.filter(item => item.selected).length} selected</strong><button type="button" className="channels-button channels-button-small" disabled={!!busy} onClick={onAddSelected}>Add selected to Ready</button></div>{planItems.map(item => <label className={`channels-proposal ${item.selected ? 'is-selected' : ''}`} key={item.id}><input type="checkbox" checked={item.selected} onChange={event => setPlanItems(items => items.map(candidate => candidate.id === item.id ? { ...candidate, selected: event.target.checked } : candidate))} disabled={!!busy} /><span><strong>{item.title}</strong>{item.hook && <small>{item.hook}</small>}{item.angle && <em>{item.angle}</em>}</span></label>)}</div>}</section>;
}

export default function ChannelsStudio({ onOpenCreative }) {
  const bridge = bridgeFromWindow();
  const [recents, setRecents] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [ideaDraft, setIdeaDraft] = useState(() => blankVideoDraft({}));
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [planner, setPlanner] = useState({ count: 10, goals: '', niche: '', referenceUrls: ['', ''] });
  const [planItems, setPlanItems] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [googleAccount, setGoogleAccount] = useState(null);
  const [analyticsAccount, setAnalyticsAccount] = useState(null);
  const [analyticsRange, setAnalyticsRange] = useState(defaultAnalyticsRange);
  const [analyticsReport, setAnalyticsReport] = useState(null);
  const mounted = useRef(true);

  const manifest = snapshot?.manifest || null;
  const videos = useMemo(() => channelVideos(manifest || {}), [manifest]);
  const groups = useMemo(() => groupedChannelVideos(manifest || {}), [manifest]);
  const readyVideos = useMemo(() => readyChannelVideos(manifest || {}), [manifest]);
  const nextReady = useMemo(() => nextReadyChannelVideo(manifest || {}), [manifest]);

  const refreshRecents = useCallback(async () => {
    if (!bridge?.recent) return;
    try {
      const response = await bridge.recent();
      if (!mounted.current) return;
      if (!response?.ok) { setError(errorText(response?.error, 'Channel workspaces could not be loaded.')); return; }
      setRecents(recentsFromResponse(response));
    } catch (value) { if (mounted.current) setError(errorText(value, 'Channel workspaces could not be loaded.')); }
  }, [bridge]);

  const applySnapshot = useCallback(value => {
    if (!value?.ok) { setError(errorText(value?.error, 'The channel workspace could not be opened.')); return false; }
    setSnapshot(value); if (value.manifest?.analysis) setAnalysis(normalizeAnalysis(value.manifest.analysis)); setError(''); return true;
  }, []);

  useEffect(() => {
    mounted.current = true;
    refreshRecents();
    return () => { mounted.current = false; };
  }, [refreshRecents]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.agents?.detect) { setAgentsLoaded(true); return undefined; }
    window.agents.detect().then(result => { if (result?.ok) setAgents(result.agents || []); setAgentsLoaded(true); }).catch(() => setAgentsLoaded(true));
    return undefined;
  }, []);

  const refreshGoogle = useCallback(async () => {
    if (!bridge?.googleAccount) return;
    try { setGoogleAccount(await bridge.googleAccount()); }
    catch (value) { setGoogleAccount({ connected: false, error: errorText(value) }); }
  }, [bridge]);

  useEffect(() => { refreshGoogle(); }, [refreshGoogle]);

  const refreshAnalyticsAccount = useCallback(async () => {
    if (!bridge?.analyticsAccount) return;
    try { setAnalyticsAccount(await bridge.analyticsAccount()); }
    catch (value) { setAnalyticsAccount({ connected: false, error: errorText(value) }); }
  }, [bridge]);
  useEffect(() => { refreshAnalyticsAccount(); }, [refreshAnalyticsAccount]);

  const openChannel = async dir => {
    if (!bridge?.get || !dir || busy) return;
    setBusy('open'); setError('');
    try { applySnapshot(await bridge.get(dir)); }
    catch (value) { setError(errorText(value, 'The channel workspace could not be opened.')); }
    finally { setBusy(''); }
  };

  const createChannel = async event => {
    event.preventDefault();
    const input = channelInputFromDraft(draft);
    if (!input.name) { setError('Give this channel a name before creating it.'); return; }
    if (!bridge?.pickRoot || !bridge?.create) return;
    setBusy('create'); setError(''); setMessage('');
    try {
      const picked = await bridge.pickRoot();
      if (picked?.canceled) return;
      if (!picked?.ok) { setError(errorText(picked?.error, 'Choose a folder for this channel workspace.')); return; }
      const result = await bridge.create({ root: picked.dir, channel: input });
      if (applySnapshot(result)) {
        setWizardOpen(false); setDraft(EMPTY_DRAFT); setIdeaDraft(blankVideoDraft(result.manifest || {}));
        setMessage('Local channel workspace created. Add ideas to begin its production queue.'); await refreshRecents();
      }
    } catch (value) { setError(errorText(value, 'This channel workspace could not be created.')); }
    finally { setBusy(''); }
  };

  const analyzeDraft = () => {
    const research = researchInputFromDraft(draft);
    if (research.mode === 'niche') { setMessage('Niche planning is ready. You can create the workspace and generate a draft plan there.'); return; }
    analyzeChannel(research);
  };

  const analyzeChannel = async input => {
    if (!bridge?.analyzeYouTube) { setMessage('Public profile analysis is unavailable in this desktop build.'); return null; }
    setBusy('analyze'); setError('');
    try {
      const result = await bridge.analyzeYouTube(input);
      if (!result?.ok) { setError(errorText(result?.error, 'The public profile could not be analyzed.')); return null; }
      const normalized = normalizeAnalysis(result); setAnalysis(normalized); return normalized;
    } catch (value) { setError(errorText(value, 'The public profile could not be analyzed.')); return null; }
    finally { setBusy(''); }
  };

  const generatePlan = async event => {
    event?.preventDefault();
    if (!snapshot?.dir) return;
    if (!bridge?.plan) { setMessage('Planning is unavailable in this desktop build.'); return; }
    setBusy('plan'); setError(''); setMessage('');
    try {
      const result = await bridge.plan(snapshot.dir, plannerInputFromDraft(planner));
      if (!result?.ok) { setError(errorText(result?.error, 'The plan could not be generated.')); return; }
      setPlanItems(normalizePlanItems(result)); setMessage('Draft plan generated. Review the ideas before adding them to Ready.');
    } catch (value) { setError(errorText(value, 'The plan could not be generated.')); }
    finally { setBusy(''); }
  };

  const addSelectedPlan = async () => {
    const selected = planItems.filter(item => item.selected);
    if (!selected.length) { setError('Select at least one proposed idea.'); return; }
    if (!bridge?.addPlanned) { setMessage('Adding planned ideas is unavailable in this desktop build.'); return; }
    setBusy('add-planned'); setError('');
    try {
      const result = await bridge.addPlanned(snapshot.dir, selected);
      if (!result?.ok) { setError(errorText(result?.error, 'Selected ideas could not be added.')); return; }
      setPlanItems(items => items.filter(item => !item.selected)); applySnapshot(result); setMessage(`${selected.length} selected idea${selected.length === 1 ? '' : 's'} added to Ready.`);
    } catch (value) { setError(errorText(value, 'Selected ideas could not be added.')); }
    finally { setBusy(''); }
  };

  const mutate = async (key, operation, successMessage) => {
    if (!snapshot?.dir || busy) return null;
    setBusy(key); setError(''); setMessage('');
    try {
      const result = await operation();
      if (applySnapshot(result)) { setMessage(successMessage); await refreshRecents(); return result; }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
    return null;
  };

  const addIdea = async event => {
    event.preventDefault();
    const input = videoInputFromDraft(ideaDraft, manifest || {});
    if (!input.title) { setError('Add a working title before saving this idea.'); return; }
    const result = await mutate('add-idea', () => bridge?.addVideo?.(snapshot.dir, input), 'Idea added to Ready.');
    if (result) { setIdeaOpen(false); setIdeaDraft(blankVideoDraft(result.manifest || manifest || {})); }
  };

  const saveEdit = async event => {
    event.preventDefault();
    if (!editing?.video?.id) return;
    const input = videoInputFromDraft(editing.draft, manifest || {});
    const result = await mutate(`edit-${editing.video.id}`, () => bridge?.updateVideo?.(snapshot.dir, editing.video.id, input), 'Idea updated.');
    if (result) setEditing(null);
  };

  const archiveVideo = video => mutate(`archive-${video.id}`, () => bridge?.archiveVideo?.(snapshot.dir, video.id), 'Idea archived.');

  const connectGoogle = async () => {
    if (!bridge?.googleConnect || busy) return;
    setBusy('google'); setError('');
    try { const result = await bridge.googleConnect(); setGoogleAccount(result); if (!result?.connected) setError(errorText(result?.error || result?.hint, 'Google sign-in did not complete.')); }
    catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  };

  const setupGoogle = async () => {
    if (!bridge?.googleSetup || busy) return;
    setBusy('google'); setError('');
    try { const result = await bridge.googleSetup(); setGoogleAccount(result); if (result?.ok) setMessage('Google OAuth client added. Connect your account to continue.'); else if (!result?.canceled) setError(errorText(result?.error)); }
    catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  };

  const trackerAction = async action => {
    if (!snapshot?.dir || busy) return;
    const method = action === 'create' ? 'trackerCreate' : action === 'pull' ? 'trackerPull' : 'trackerPush';
    if (!bridge?.[method]) return;
    setBusy(`tracker-${action}`); setError(''); setMessage('');
    try {
      const result = action === 'create'
        ? await bridge[method](snapshot.dir, { title: `${manifest.name} — Vidmyo tracker` })
        : await bridge[method](snapshot.dir);
      if (result?.manifest) setSnapshot({ ok: true, dir: snapshot.dir, manifest: result.manifest });
      if (result?.conflict) setError(`Sync stopped because local and Google edits conflict for ${result.conflicts?.length || 0} video(s). Pull or review those rows before retrying.`);
      else if (!result?.ok) setError(errorText(result?.error, 'Google Tracker could not be synchronized.'));
      else setMessage(action === 'create' ? 'Google Tracker created and linked.' : action === 'pull' ? 'Google Tracker changes pulled.' : 'Local queue pushed to Google Tracker.');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  };

  const analyticsAuth = async action => {
    const method = action === 'setup' ? 'analyticsSetup' : 'analyticsConnect';
    if (!bridge?.[method] || busy) return;
    setBusy(`analytics-${action}`); setError('');
    try {
      const result = await bridge[method]();
      if (!result?.ok && !result?.canceled) setError(errorText(result?.error, 'YouTube Analytics connection did not complete.'));
      await refreshAnalyticsAccount();
    } catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  };

  const loadAnalytics = async () => {
    if (!bridge?.analyticsReport || busy) return;
    setBusy('analytics-report'); setError('');
    try {
      const result = await bridge.analyticsReport(analyticsRange);
      if (!result?.ok) setError(errorText(result?.error, 'YouTube Analytics could not be loaded.'));
      else { setAnalyticsReport(result.report); setMessage('Private YouTube Analytics updated.'); }
    } catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  };

  const chooseVideo = async video => {
    const result = await mutate(`choose-${video.id}`, () => bridge?.claimVideo?.(snapshot.dir, video.id, { source: 'channels' }), `${video.title} is reserved for production.`);
    if (!result) return;
    if (bridge?.openInCreative) {
      try { const handoff = await bridge.openInCreative(snapshot.dir, video.id); if (!handoff?.ok) throw new Error(handoff?.error); onOpenCreative?.(handoff); }
      catch { setMessage(`${video.title} is reserved. Stickman and Animations handoff will be available when its workspace is connected.`); }
    } else setMessage(`${video.title} is reserved. Stickman and Animations handoff is the next integration step.`);
  };

  const chooseNext = async () => {
    if (!nextReady) return;
    const result = await mutate('next', () => bridge?.claimNext?.(snapshot.dir, { source: 'channels' }), `${nextReady.title} is reserved for production.`);
    if (!result) return;
    if (bridge?.openInCreative) {
      try { const handoff = await bridge.openInCreative(snapshot.dir, nextReady.id); if (!handoff?.ok) throw new Error(handoff?.error); onOpenCreative?.(handoff); }
      catch { setMessage(`${nextReady.title} is reserved. Stickman and Animations handoff will be available when its workspace is connected.`); }
    } else setMessage(`${nextReady.title} is reserved. Stickman and Animations handoff is the next integration step.`);
  };

  const tracker = manifest?.tracker;
  return <div className="channels-studio">
    <div className="channels-frame">
      <header className="channels-header">
        <div><div className="channels-kicker">Channel workspace</div><h1 className="channels-title">Turn channel signals into a useful slate.</h1><p className="channels-lede">Review public profile evidence, define a niche, and keep proposed ideas moving into production.</p></div>
        <div className="channels-header-actions">
          <button type="button" className="channels-button" disabled={!bridge || !!busy} onClick={refreshRecents}>Refresh</button>
          <button type="button" className="channels-button channels-button-primary" disabled={!bridge || !!busy} onClick={() => { setDraft(EMPTY_DRAFT); setWizardOpen(true); setError(''); setMessage(''); }}>New channel</button>
        </div>
      </header>

      {!bridge && <div className="channels-callout channels-callout-warning" role="status"><strong>Channels are available in the Vidmyo desktop app.</strong> Create and open local workspaces when the desktop bridge is connected.</div>}
      {(error || message) && <div className={`channels-callout ${error ? 'channels-callout-error' : ''}`} role={error ? 'alert' : 'status'}>{error || message}</div>}

      {wizardOpen && <section className="channels-card channels-wizard" aria-labelledby="new-channel-title"><div className="channels-card-heading"><div><h2 id="new-channel-title">Start a channel workspace</h2><p>Choose a public reference or start from a niche. Any analysis uses public profile evidence and describes possible opportunities without guarantees.</p></div><button type="button" className="channels-button channels-button-quiet" onClick={() => setWizardOpen(false)} disabled={busy === 'create'}>Close</button></div><form onSubmit={createChannel}><ChannelForm draft={draft} onChange={setDraft} disabled={!!busy} /><div className="channels-form-actions"><button type="button" className="channels-button" disabled={!!busy || !bridge || draft.sourceMode === 'niche'} onClick={analyzeDraft}>{busy === 'analyze' ? 'Analyzing…' : 'Analyze public profile'}</button><button type="submit" className="channels-button channels-button-primary" disabled={!bridge || busy === 'create'}>{busy === 'create' ? 'Creating workspace…' : 'Choose folder & create channel'}</button></div></form>{analysis && <AnalysisCard analysis={analysis} />}</section>}

      {!manifest && !wizardOpen && <section className="channels-empty-layout">
        <div className="channels-card channels-empty"><div className="channels-empty-mark" aria-hidden="true">◫</div><h2>Your channel workspace starts here.</h2><p>Create a channel to keep video ideas, status and production defaults together on this computer.</p><button type="button" className="channels-button channels-button-primary" disabled={!bridge} onClick={() => setWizardOpen(true)}>Create local channel</button></div>
        <aside className="channels-card"><div className="channels-card-heading"><div><h2>Recent channels</h2><p>Reopen a local workspace.</p></div></div>{recents.length ? <div className="channels-recent-list">{recents.map(item => <button key={item.dir} type="button" className="channels-recent-item" disabled={busy === 'open'} onClick={() => openChannel(item.dir)}><span><strong>{item.name || item.manifest?.name || 'Unnamed channel'}</strong><small>{item.dir}</small></span><span>Open</span></button>)}</div> : <p className="channels-muted">No local channel workspaces yet.</p>}</aside>
      </section>}

      {manifest && <>
        <section className="channels-channel-header">
          <div><div className="channels-kicker">Active channel</div><h2>{manifest.name || 'Unnamed channel'}</h2><p>{manifest.strategy?.positioning || 'Add a positioning statement when you create the channel.'}</p><div className="channels-meta"><span>{manifest.strategy?.language || 'English'}</span><span>{manifest.strategy?.audience || 'Audience not set'}</span><span>{manifest.defaults?.kind === 'animation' ? 'Animations' : 'Stickman'} · {manifest.defaults?.style || 'Style not set'} · {manifest.defaults?.aspect || '16:9'} · {durationLabel(manifest.defaults?.durationSec)}</span></div></div>
          <div className="channels-header-actions"><button type="button" className="channels-button" disabled={!!busy || !bridge?.analyzeYouTube || !manifest.research} onClick={() => analyzeChannel(manifest.research)}>{busy === 'analyze' ? 'Analyzing…' : 'Review public profile'}</button><button type="button" className="channels-button" disabled={!!busy || !nextReady} onClick={() => document.getElementById('channels-ready')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Choose a video</button><button type="button" className="channels-button channels-button-primary" disabled={!!busy || !nextReady} onClick={chooseNext}>{busy === 'next' ? 'Creating…' : nextReady ? 'Create next video' : 'No ready videos'}</button></div>
        </section>

        <section className="channels-stats" aria-label="Queue status">{CHANNEL_QUEUE_GROUPS.map(group => { const count = groups.find(item => item.id === group.id)?.videos.length || 0; return <div key={group.id}><strong>{count}</strong><span>{group.label}</span></div>; })}</section>

        <div className="channels-dashboard-grid">
          <section className="channels-card"><div className="channels-card-heading"><div><h2>Google Tracker</h2><p>{tracker?.sheetId ? `Connected tracker: ${tracker.tab || 'Videos'}` : 'Your local queue is the source of truth.'}</p></div>{googleAccount?.connected && <span className="channels-coming">{googleAccount.email || 'Google connected'}</span>}</div><p className="channels-muted">Create the Vidmyo 21-column tracker, then pull Sheet edits or push reviewed local changes. Conflicts stop before either side is overwritten.</p><div className="channels-form-actions">{!googleAccount?.connected && googleAccount?.canSetup && <button type="button" className="channels-button" disabled={!!busy} onClick={setupGoogle}>Add Google login</button>}{!googleAccount?.connected && googleAccount?.canConnect && <button type="button" className="channels-button" disabled={!!busy} onClick={connectGoogle}>{busy === 'google' ? 'Connecting…' : 'Connect Google'}</button>}{googleAccount?.connected && !tracker?.sheetId && <button type="button" className="channels-button channels-button-primary" disabled={!!busy} onClick={() => trackerAction('create')}>{busy === 'tracker-create' ? 'Creating…' : 'Create Google Tracker'}</button>}{googleAccount?.connected && tracker?.sheetId && <><button type="button" className="channels-button" disabled={!!busy} onClick={() => trackerAction('pull')}>Pull from Google</button><button type="button" className="channels-button channels-button-primary" disabled={!!busy} onClick={() => trackerAction('push')}>Push to Google</button></>}</div>{!googleAccount?.connected && googleAccount?.hint && <p className="channels-muted">{googleAccount.hint}</p>}</section>
          <section className="channels-card"><div className="channels-card-heading"><div><h2>Research signals</h2><p>Use public profile evidence as context for decisions.</p></div></div><p className="channels-muted">Analysis describes observable patterns and possible opportunities. It does not promise reach or predict outcomes.</p></section>
        </div>

        <section className="channels-card"><div className="channels-card-heading"><div><h2>Private YouTube Analytics</h2><p>Optional account-owned performance context. Access is read-only and separate from public channel research.</p></div>{analyticsAccount?.connected && <span className="channels-coming">Connected</span>}</div>{!analyticsAccount?.connected ? <div className="channels-form-actions">{analyticsAccount?.configured ? <button type="button" className="channels-button channels-button-primary" disabled={!!busy} onClick={() => analyticsAuth('connect')}>Connect YouTube Analytics</button> : <button type="button" className="channels-button" disabled={!!busy} onClick={() => analyticsAuth('setup')}>Add Analytics Google login</button>}</div> : <><div className="channels-form-grid compact"><Field label="Start date"><input className="channels-input" type="date" value={analyticsRange.startDate} onChange={event => setAnalyticsRange(value => ({ ...value, startDate: event.target.value }))} /></Field><Field label="End date"><input className="channels-input" type="date" value={analyticsRange.endDate} onChange={event => setAnalyticsRange(value => ({ ...value, endDate: event.target.value }))} /></Field></div><div className="channels-form-actions"><button type="button" className="channels-button channels-button-primary" disabled={!!busy} onClick={loadAnalytics}>{busy === 'analytics-report' ? 'Loading…' : 'Load analytics'}</button></div></>}{analyticsReport?.aggregates && <div className="channels-stats" aria-label="YouTube Analytics totals"><div><strong>{analyticsReport.aggregates.views}</strong><span>Views</span></div><div><strong>{Math.round(analyticsReport.aggregates.estimatedMinutesWatched)}</strong><span>Minutes watched</span></div><div><strong>{analyticsReport.aggregates.averageViewDuration == null ? '—' : `${Math.round(analyticsReport.aggregates.averageViewDuration)}s`}</strong><span>Average view</span></div><div><strong>{analyticsReport.aggregates.subscribersGained}</strong><span>Subscribers gained</span></div></div>}</section>

        {analysis && <AnalysisCard analysis={analysis} />}
        <PlannerCard planner={planner} setPlanner={setPlanner} planItems={planItems} setPlanItems={setPlanItems} busy={busy} onGenerate={generatePlan} onAddSelected={addSelectedPlan} agents={agents} agentsLoaded={agentsLoaded} />

        <section className="channels-card channels-ideas"><div className="channels-card-heading"><div><h2>Add a local video idea</h2><p>Add approved ideas manually while the guided planner is being built.</p></div><button type="button" className="channels-button channels-button-small" disabled={!!busy} aria-expanded={ideaOpen} onClick={() => { setIdeaDraft(blankVideoDraft(manifest)); setIdeaOpen(value => !value); }}>{ideaOpen ? 'Close' : 'Add idea'}</button></div>{ideaOpen && <form onSubmit={addIdea}><VideoForm draft={ideaDraft} channel={manifest} onChange={setIdeaDraft} disabled={busy === 'add-idea'} /><div className="channels-form-actions"><button type="submit" className="channels-button channels-button-primary" disabled={busy === 'add-idea'}>{busy === 'add-idea' ? 'Adding…' : 'Add to Ready'}</button></div></form>}</section>

        {editing && <section className="channels-card channels-edit" aria-labelledby="edit-idea-title"><div className="channels-card-heading"><div><h2 id="edit-idea-title">Edit idea</h2><p>Changes are saved locally to this channel workspace.</p></div><button type="button" className="channels-button channels-button-quiet" onClick={() => setEditing(null)} disabled={!!busy}>Close</button></div><form onSubmit={saveEdit}><VideoForm draft={editing.draft} channel={manifest} onChange={next => setEditing(current => ({ ...current, draft: typeof next === 'function' ? next(current.draft) : next }))} disabled={busy === `edit-${editing.video.id}`} /><div className="channels-form-actions"><button type="submit" className="channels-button channels-button-primary" disabled={!!busy}>{busy === `edit-${editing.video.id}` ? 'Saving…' : 'Save idea'}</button></div></form></section>}

        <section className="channels-queue" aria-labelledby="queue-title"><div className="channels-queue-heading"><div><div className="channels-kicker">Production queue</div><h2 id="queue-title">Every idea has a visible state.</h2></div><span>{videos.length} total</span></div>{groups.map(group => <div className="channels-queue-group" id={group.id === 'ready' ? 'channels-ready' : undefined} key={group.id}><div className="channels-group-heading"><h3>{group.label}</h3><span>{group.videos.length}</span></div>{group.videos.length ? <div className="channels-table-wrap"><table><thead><tr><th>#</th><th>Idea</th><th>Format</th><th>Priority</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{group.videos.map(video => <QueueRow key={video.id || `${video.sequence}-${video.title}`} video={video} busy={busy} onChoose={chooseVideo} onEdit={value => setEditing({ video: value, draft: videoDraft(value, manifest) })} onArchive={archiveVideo} />)}</tbody></table></div> : <p className="channels-empty-group">{group.id === 'ready' ? 'No ready ideas yet. Add one above or wait for the guided planner.' : `No videos ${group.label.toLowerCase()}.`}</p>}</div>)}</section>
      </>}
    </div>
  </div>;
}
