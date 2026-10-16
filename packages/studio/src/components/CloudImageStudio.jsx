import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadGenerationHistory, saveGenerationSettings } from '../creativeHistory.mjs';
import { loadCreativeLibrary, saveJobMetadata, jobMetadata, matchesLibraryFilter } from '../creativeLibrary.mjs';
import { LibraryFilter, LibraryEntry } from './CreativeLibrary.jsx';
import { imageReadResultToHandoff } from '../creativeHandoff.mjs';
import { canSubmitProviderRequest } from '../spendAuthorization.mjs';
import { GENERATION_SOURCES, buildGenerationParams } from '../../../core/src/generation.js';
import GenerationRecovery from './GenerationRecovery';

const surface = {
  background: 'var(--vm-panel)',
  border: '1px solid rgba(148,163,184,.16)', borderRadius: 18, padding: 18,
};
const field = {
  width: '100%', boxSizing: 'border-box', background: 'var(--vm-input)', color: 'var(--vm-text)',
  border: '1px solid rgba(148,163,184,.22)', borderRadius: 10, padding: '10px 12px',
};
const button = {
  border: '1px solid rgba(148,163,184,.22)', borderRadius: 10, padding: '9px 13px',
  background: 'var(--vm-raised)', color: 'var(--vm-text)', cursor: 'pointer', fontWeight: 650,
};
const primaryButton = { ...button, background: 'var(--vm-primary)', color: 'var(--vm-on-primary)', borderColor: 'var(--vm-accent)' };
const muted = { color: 'var(--vm-muted)', fontSize: 13, lineHeight: 1.45 };
const label = { display: 'block', color: 'var(--vm-muted)', fontSize: 12, fontWeight: 700, marginBottom: 6 };

const IMAGE_MODELS = [
  ...GENERATION_SOURCES.flatMap(source => source.models.image.map(item => ({
    ...item, provider: source.name, providerId: source.provider,
    note: 'Available in Vidmyo’s shared provider catalog. Compatibility can still vary when a provider changes its API.',
  }))),
  { id: '__custom_fal__', label: 'Custom fal.ai endpoint', provider: 'fal.ai', providerId: 'fal', note: 'Input compatibility is unknown until the endpoint is tested.' },
];

const ASPECTS = [
  ['1:1', 'Square · 1:1'], ['4:3', 'Landscape · 4:3'],
  ['16:9', 'Widescreen · 16:9'], ['3:4', 'Portrait · 3:4'],
  ['9:16', 'Vertical · 9:16'],
];
const normalizeImageAspect = value => ({ square: '1:1', landscape_4_3: '4:3', landscape_16_9: '16:9', portrait_4_3: '3:4', portrait_16_9: '9:16' }[value] || value || '1:1');

function formatDate(value) {
  if (!value) return 'This session';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

function ProgressState({ activity, busy, elapsed, onCancel }) {
  if (!activity) return null;
  const phase = activity.phase === 'preparing' ? 'Preparing request'
    : activity.phase === 'start' ? 'Provider request started'
      : activity.phase === 'done' ? 'Completed' : activity.phase === 'error' ? 'Failed' : activity.phase;
  return (
    <div aria-live="polite" style={{ ...surface, padding: 12, borderColor: activity.phase === 'error' ? '#7f1d1d' : 'rgba(99,102,241,.45)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <strong style={{ color: activity.phase === 'error' ? 'var(--vm-danger)' : 'var(--vm-accent)' }}>{phase}</strong>
        {busy && <span style={muted}>{elapsed}s elapsed</span>}
      </div>
      {activity.jobId && <div style={{ ...muted, marginTop: 4 }}>Job {activity.jobId}</div>}
      {activity.message && <div style={{ color: 'var(--vm-danger)', fontSize: 13, marginTop: 5 }}>{activity.message}</div>}
      {busy && <div style={{ ...muted, marginTop: 5 }}>This provider bridge reports lifecycle events, not a percentage or queue position.</div>}
      {busy && activity.jobId && <button type="button" onClick={onCancel} style={{ ...button, marginTop: 9, color: 'var(--vm-danger)' }}>Cancel request</button>}
    </div>
  );
}

export default function CloudImageStudio({ onUseInVideo }) {
  const hasBridge = typeof window !== 'undefined' && !!window.media?.isElectron;
  const api = hasBridge ? window.media : null;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(IMAGE_MODELS[0].id);
  const [customModel, setCustomModel] = useState('');
  const [aspect, setAspect] = useState('1:1');
  const [spendApproved, setSpendApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState([]);
  const [library,setLibrary] = useState(()=>loadCreativeLibrary(typeof window==='undefined'?null:window.localStorage));
  const [libraryFilter,setLibraryFilter] = useState('all');
  const updateMetadata = (jobId,patch) => {
    const saved=saveJobMetadata(window.localStorage,library,'image',jobId,patch); setLibrary(saved.library);
    if (!saved.persisted) setError('Collection changes are available this session only; local storage could not be saved.');
  };
  const [pendingJobs, setPendingJobs] = useState([]);
  const [settingsHistory, setSettingsHistory] = useState(() => (
    typeof window === 'undefined' ? {} : loadGenerationHistory(window.localStorage, 'image')
  ));
  const [activity, setActivity] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const busyRef = useRef(false);
  const expectedModelRef = useRef('');
  const previewBlob = useRef(null);
  useEffect(() => () => { if (previewBlob.current) URL.revokeObjectURL(previewBlob.current); }, []);

  const selectedModel = useMemo(() => IMAGE_MODELS.find((item) => item.id === model) || IMAGE_MODELS[0], [model]);
  const endpoint = model === '__custom_fal__' ? customModel.trim() : model;
  const canGenerate = canSubmitProviderRequest({ approved: spendApproved, busy, prompt, endpoint });
  useEffect(() => { setSpendApproved(false); }, [model, customModel, aspect]);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    if (!busy) return undefined;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!api?.onProgress) return undefined;
    return api.onProgress((event) => {
      if (!event || !event.phase) return;
      setActivity((current) => {
        if (event.phase === 'start') {
          if (!busyRef.current || event.model !== expectedModelRef.current) return current;
          return { phase: 'start', jobId: event.jobId, model: event.model };
        }
        if (!current?.jobId || event.jobId !== current.jobId) return current;
        return { ...current, phase: event.phase, message: event.message || '' };
      });
    });
  }, [api]);

  const loadRecent = useCallback(async () => {
    if (!api?.recent) return;
    const rows = await api.recent({ type: 'image' });
    if (rows?.ok) setRecent(rows.jobs || []);
  }, [api]);

  const loadPending = useCallback(async () => {
    if (!api?.listJobs) return;
    const rows = await api.listJobs({ type: 'image' });
    if (rows?.ok) setPendingJobs(rows.jobs || []);
  }, [api]);

  useEffect(() => { Promise.all([loadRecent(), loadPending()]).catch(() => setError('Could not load generation history. Reopen this studio to retry.')); }, [loadRecent, loadPending]);

  async function cancelJob(job) {
    const response = await api.cancelJob(job.id);
    if (!response?.ok) setError(response?.error || 'Could not cancel this generation.');
    else setActivity(current => current?.jobId === job.id ? { ...current, phase: 'cancelled' } : current);
    await loadPending();
  }
  const cancelCurrent = () => activity?.jobId ? cancelJob({ id: activity.jobId }) : undefined;

  async function resumeJob(job) {
    if (busyRef.current) return;
    setBusy(true); busyRef.current = true; setError(''); setActivity({ phase: 'start', jobId: job.id, model: job.model });
    try {
      const response = await api.resumeJob(job.id);
      if (response?.canceled) { setActivity({ phase: 'cancelled', jobId: job.id }); return; }
      if (!response?.ok) throw new Error(response?.error || 'Could not resume this generation.');
      setResult({ ...response, jobId:job.id, details: settingsHistory[job.id] });
      setActivity({ phase: 'done', jobId: job.id });
      await loadRecent();
    } catch (failure) { setError(failure.message); setActivity({ phase: 'error', jobId: job.id, message: failure.message }); }
    finally { busyRef.current = false; setBusy(false); await loadPending(); }
  }

  async function showHistory(job, details) {
    try {
      const response = await api.readFile(job.artifact);
      if (!response?.ok) throw new Error(response?.error || 'Could not load this image');
      if (previewBlob.current) URL.revokeObjectURL(previewBlob.current);
      previewBlob.current = URL.createObjectURL(new Blob([response.bytes], { type: response.mime }));
      setResult({ dataUrl: previewBlob.current, path: job.artifact, jobId: job.id, details });
    } catch (failure) { setError(failure.message); }
  }

  async function useInVideo(artifact, sourcePrompt, jobId) {
    try {
      setError('');
      const response = await api.readFile(artifact);
      onUseInVideo(imageReadResultToHandoff({ artifact, prompt: sourcePrompt, jobId, collection: jobMetadata(library,'image',jobId).collection }, response));
    } catch (failure) {
      setError(failure.message || 'Could not prepare this image for Video');
    }
  }

  function applySettings(details) {
    if (!details) return;
    setPrompt(details.prompt || '');
    setModel(details.model || IMAGE_MODELS[0].id);
    setCustomModel(details.customModel || '');
    setAspect(normalizeImageAspect(details.aspect));
    setError('');
  }

  async function generate() {
    if (!canSubmitProviderRequest({ approved: spendApproved, busy: busyRef.current, prompt, endpoint })) return;
    const details = {
      prompt: prompt.trim(), model, endpoint, customModel: customModel.trim(), aspect,
      provider: selectedModel.provider, modelLabel: selectedModel.label,
    };
    setBusy(true);
    busyRef.current = true;
    setError('');
    expectedModelRef.current = endpoint;
    setActivity({ phase: 'preparing', model: endpoint });
    setSpendApproved(false);
    try {
      const provider = selectedModel.providerId;
      const params = { ...buildGenerationParams(provider, 'image', { prompt: details.prompt, aspect }), ...(provider === 'fal' ? { num_images: 1 } : {}) };
      const request = { kind: 'image', provider, model: endpoint, params };
      const authorization = await api.authorizeGeneration(request);
      if (!authorization?.ok) throw new Error(authorization?.error || 'Could not authorize this provider request.');
      const response = await api.generate({ ...request, authorizationId: authorization.authorizationId });
      if (response?.canceled) { setActivity(current => ({ ...(current || {}), phase: 'cancelled' })); return; }
      if (!response?.ok) throw new Error(response?.error || 'Generation failed');
      const completed = { ...response, details };
      setResult(completed);
      setSettingsHistory(saveGenerationSettings(window.localStorage, 'image', response.jobId, details));
      setActivity((current) => ({ ...(current || {}), phase: 'done', jobId: response.jobId || current?.jobId }));
      await loadRecent();
    } catch (generationError) {
      const message = generationError.message || String(generationError);
      setError(message);
      setActivity((current) => ({ ...(current || {}), phase: 'error', message }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!hasBridge) return <div style={surface}>Cloud Image Studio is available in the Vidmyo desktop app.</div>;

  return (
    <div className="cloud-image-studio" style={{ color: 'var(--vm-text)', background: 'var(--vm-bg)', maxWidth: 1400, margin: '0 auto', padding: '24px 22px 34px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <style>{`.cloud-image-studio :focus-visible{outline:2px solid var(--vm-accent);outline-offset:3px}`}</style>
      <div style={{ marginBottom: 18 }}>
        <div style={{ color: 'var(--vm-accent)', textTransform: 'uppercase', fontSize: 11, letterSpacing: '.13em', fontWeight: 800 }}>Cloud Studio</div>
        <h2 style={{ margin: '5px 0 4px', fontSize: 28 }}>Image generation</h2>
        <p style={{ ...muted, margin: 0 }}>Create a provider-backed image, then reuse its prompt and settings for another variation—even after reopening Vidmyo.</p>
      </div>

      <div style={{ ...surface, padding: 14, marginBottom: 16, borderColor: 'rgba(59,130,246,.4)' }}>
        <strong style={{ color: 'var(--vm-accent)' }}>API generation · separate from subscription agents</strong>
        <div style={{ ...muted, marginTop: 4 }}>
          Generate calls the selected provider with the API key configured in Vidmyo. ChatGPT, Claude, or other agent subscriptions do not cover this call. Provider cost is not available in this screen—check the provider before generating.
        </div>
      </div>
      <GenerationRecovery jobs={pendingJobs} busy={busy} onResume={resumeJob} onCancel={cancelJob} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 16, alignItems: 'start' }}>
        <section style={{ display: 'grid', gap: 14 }}>
          <div style={surface}>
            <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>1 · Prompt</h3>
            <label htmlFor="image-prompt" style={label}>Describe the image</label>
            <textarea id="image-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder="Subject, composition, lighting, style…" style={{ ...field, resize: 'vertical', lineHeight: 1.5 }} />
          </div>

          <div style={surface}>
            <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>2 · Provider settings</h3>
            <label htmlFor="image-model" style={label}>Model</label>
            <select id="image-model" value={model} onChange={(event) => setModel(event.target.value)} style={field}>
              {IMAGE_MODELS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.provider}</option>)}
            </select>
            {model === '__custom_fal__' && <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="fal-ai/your-endpoint" style={{ ...field, marginTop: 9 }} />}
            <div style={{ ...muted, marginTop: 8, color: selectedModel.verified ? 'var(--vm-good)' : 'var(--vm-warning)' }}>
              {selectedModel.verified ? 'Verified in this build. ' : 'Compatibility not verified. '}{selectedModel.note}
            </div>

            <label htmlFor="image-aspect" style={{ ...label, marginTop: 15 }}>Aspect ratio</label>
            <select id="image-aspect" value={aspect} onChange={(event) => setAspect(event.target.value)} style={field}>
              {ASPECTS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>

            <div style={{ ...surface, padding: 11, marginTop: 15, background: 'var(--vm-input)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedModel.provider} API</span>
                <span style={{ ...muted, fontSize: 12 }}>Cost unavailable</span>
              </div>
              <div style={{ ...muted, marginTop: 4 }}>Vidmyo cannot estimate this request from the current provider bridge.</div>
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 13, color: 'var(--vm-text)', fontSize: 12, lineHeight: 1.45 }}>
              <input type="checkbox" checked={spendApproved} onChange={event => setSpendApproved(event.target.checked)} />
              Approve one {selectedModel.provider} API request. Its cost is unknown here, and the prompt leaves this device.
            </label>

            <button onClick={generate} disabled={!canGenerate} style={{ ...primaryButton, width: '100%', marginTop: 14, opacity: canGenerate ? 1 : .5 }}>
              {busy ? 'Waiting for provider…' : 'Generate image'}
            </button>
          </div>

          <ProgressState activity={activity} busy={busy} elapsed={elapsed} onCancel={cancelCurrent} />
          {error && <div role="alert" style={{ ...surface, padding: 12, color: 'var(--vm-danger)', borderColor: '#7f1d1d' }}>{error}</div>}
        </section>

        <section style={{ display: 'grid', gap: 14 }}>
          <div style={{ ...surface, minHeight: 420 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 13 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Result</h3>
              <div style={{ display: 'flex', gap: 7 }}>
                {result?.path && onUseInVideo && <button onClick={() => useInVideo(result.path, result.details?.prompt, result.jobId)} style={button}>Use in Video</button>}
                {result?.details && <button onClick={() => applySettings(result.details)} style={button}>Reuse settings</button>}
              </div>
            </div>
            {result?.dataUrl ? (
              <>
                <img src={result.dataUrl} alt={result.details?.prompt || 'Generated result'} style={{ width: '100%', maxHeight: 590, objectFit: 'contain', borderRadius: 13, background: 'var(--vm-player)' }} />
                <div style={{ ...muted, marginTop: 10 }}>{result.details?.modelLabel || 'Model unavailable'} · {result.details?.provider || 'Provider unavailable'} · {ASPECTS.find(([value]) => value === result.details?.aspect)?.[1] || result.details?.aspect || 'Settings unavailable'}</div>
              </>
            ) : (
              <div style={{ minHeight: 330, display: 'grid', placeItems: 'center', textAlign: 'center', color: 'var(--vm-muted)' }}>
                <div><div style={{ fontSize: 34, marginBottom: 8 }}>◇</div>Your next generated image will appear here.</div>
              </div>
            )}
          </div>

          <div style={surface}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Generation history</h3>
            <LibraryFilter library={library} value={libraryFilter} onChange={setLibraryFilter}/>
            <p style={{ ...muted, margin: '0 0 12px' }}>Model and settings are retained locally for recent Studio generations. Older bridge-only records may not include those fields.</p>
            {recent.length === 0 ? <div style={muted}>No completed image jobs yet.</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {recent.filter(job=>matchesLibraryFilter(library,'image',job.id,libraryFilter)).map((job) => {
                  const details = settingsHistory[job.id];
                  return (
                    <div key={job.id} style={{ background: 'var(--vm-input)', border: '1px solid rgba(148,163,184,.14)', borderRadius: 11, padding: 11 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>{job.prompt || 'Untitled prompt'}</div>
                          <div style={{ ...muted, marginTop: 4 }}>{details ? `${details.modelLabel} · ${details.provider} · ${details.aspect}` : 'Model/settings unavailable for this older job'} · {formatDate(job.endedAt)}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                          {details && <button onClick={() => applySettings(details)} style={{ ...button, padding: '6px 9px', fontSize: 12 }}>Reuse</button>}
                          {job.artifact && onUseInVideo && <button onClick={() => useInVideo(job.artifact, details?.prompt || job.prompt, job.id)} style={{ ...button, padding: '6px 9px', fontSize: 12 }}>Use in Video</button>}
                          {job.artifact && <button onClick={() => showHistory(job, details)} style={{ ...button, padding: '6px 9px', fontSize: 12 }}>Show</button>}
                          {job.artifact && <button onClick={() => api.reveal(job.artifact)} style={{ ...button, padding: '6px 9px', fontSize: 12 }}>Folder</button>}
                        </div>
                      </div>
                      <LibraryEntry library={library} kind="image" jobId={job.id} onChange={updateMetadata}/>
                    </div>
                  );
                })}
              </div>
            )}
            {recent.length>0&&!recent.some(job=>matchesLibraryFilter(library,'image',job.id,libraryFilter))&&<p style={muted}>No results match this filter. Choose All results to see your history.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
