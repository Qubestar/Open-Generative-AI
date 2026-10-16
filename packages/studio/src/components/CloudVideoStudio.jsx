import { useState, useEffect, useCallback, useRef } from 'react';
import { loadGenerationHistory, saveGenerationSettings } from '../creativeHistory.mjs';
import { loadCreativeLibrary, saveJobMetadata, jobMetadata, matchesLibraryFilter } from '../creativeLibrary.mjs';
import { LibraryFilter, LibraryEntry } from './CreativeLibrary.jsx';
import { canSubmitProviderRequest } from '../spendAuthorization.mjs';
import { videoStateFromImageHandoff } from '../creativeHandoff.mjs';
import { GENERATION_SOURCES, buildGenerationParams } from '../../../core/src/generation.js';
import GenerationRecovery from './GenerationRecovery';

// Cloud Video studio — fal.ai or Agnes AI video models through the core job
// runner (window.media → electron/lib/mediaBridge.js, keychain key per
// provider). Async durable jobs; renders can take minutes and survive an
// app restart in ~/.vidmyo/jobs.

const C = {
  card: 'var(--vm-panel)', line: 'var(--vm-line)', text: 'var(--vm-text)', dim: 'var(--vm-muted)',
  accent: 'var(--vm-accent)', bad: 'var(--vm-danger)',
};

// fal-ai/veo3 is verified (2026-07, live-tested). The others are curated from
// fal's current model listing but NOT live-tested here — try them and expect
// to iterate; fal ids also drift over time, hence Custom.
const modelsFor = kind => [
  ...GENERATION_SOURCES.flatMap(source => (source.models[kind] || []).map(item => ({ ...item, provider: source.provider, label: `${source.name} · ${item.label}` }))),
  { id: 'custom', provider: 'fal', label: 'fal.ai · Custom endpoint…' },
];
const VIDEO_MODELS_T2V = modelsFor('video');

// fal uses separate model ids for image-to-video (a different marketplace
// listing than the text-to-video ones above) — none of these are live-tested.
// Agnes's video model is unchanged: it takes the same "animate" request with
// an optional `image` field added, no separate model id needed.
const VIDEO_MODELS_I2V = modelsFor('video_i2v');

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
  background: primary ? 'var(--vm-primary)' : 'var(--vm-raised)',
  color: primary ? 'var(--vm-on-primary)' : C.text, border: primary ? 'none' : `1px solid ${C.line}`,
});

export default function CloudVideoStudio({ imageHandoff, onImageHandoffConsumed }) {
  const hasBridge = typeof window !== 'undefined' && !!window.media?.isElectron;
  const [animate, setAnimate] = useState(false);   // text-to-video vs animate-an-image
  const [sourceImage, setSourceImage] = useState(null);  // {path, dataUrl}
  const MODELS = animate ? VIDEO_MODELS_I2V : VIDEO_MODELS_T2V;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [customModel, setCustomModel] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [duration, setDuration] = useState('auto');
  const [spendApproved, setSpendApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);  // blob URL
  const [resultPath, setResultPath] = useState(null);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState([]);
  const [sourceImageJobId,setSourceImageJobId] = useState('');
  const [sourceCollection,setSourceCollection] = useState('');
  const [library,setLibrary] = useState(()=>loadCreativeLibrary(typeof window==='undefined'?null:window.localStorage));
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [libraryFilter,setLibraryFilter] = useState('all');
  const updateMetadata = (jobId,patch) => {
    const saved=saveJobMetadata(window.localStorage,library,'video',jobId,patch); setLibrary(saved.library);
    if (!saved.persisted) setError('Collection changes are available this session only; local storage could not be saved.');
  };
  const [pendingJobs, setPendingJobs] = useState([]);
  const [activity, setActivity] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [settingsHistory, setSettingsHistory] = useState(() => (
    typeof window === 'undefined' ? {} : loadGenerationHistory(window.localStorage, 'video')
  ));
  const selectedEndpoint = model === 'custom' ? customModel.trim() : model;
  const canGenerate = canSubmitProviderRequest({ approved: spendApproved, busy, prompt, endpoint: selectedEndpoint, requiresSource: animate, hasSource: Boolean(sourceImage) });
  useEffect(() => { setSpendApproved(false); }, [animate, model, customModel, aspect, duration, sourceImage]);
  const busyRef = useRef(false);
  const requestModel = useRef('');
  const previewBlob = useRef(null);
  useEffect(() => () => { if (previewBlob.current) URL.revokeObjectURL(previewBlob.current); }, []);
  useEffect(() => {
    if (!hasBridge || !window.media.onProgress) return;
    return window.media.onProgress(event => setActivity(current => {
      if (event.phase === 'start' && busyRef.current && event.model === requestModel.current) return event;
      return current?.jobId && current.jobId === event.jobId ? { ...current, ...event } : current;
    }));
  }, [hasBridge]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const loadRecent = useCallback(() => {
    if (hasBridge) window.media.recent({ type: 'video' }).then((r) => r.ok && setRecent(r.jobs)).catch(() => setError('Could not load recent videos. Reopen this studio to retry.'));
  }, [hasBridge]);
  useEffect(() => { loadRecent(); }, [loadRecent]);
  const loadPending = useCallback(() => {
    if (hasBridge && window.media.listJobs) return window.media.listJobs({ type: 'video' }).then(result => result.ok && setPendingJobs(result.jobs || []));
  }, [hasBridge]);
  useEffect(() => { loadPending(); }, [loadPending]);

  const cancelJob = async job => {
    const response = await window.media.cancelJob(job.id);
    if (!response?.ok) setError(response?.error || 'Could not cancel this generation.');
    else setActivity(current => current?.jobId === job.id ? { ...current, phase: 'cancelled' } : current);
    await loadPending();
  };
  const cancelCurrent = () => activity?.jobId ? cancelJob({ id: activity.jobId }) : undefined;

  const resumeJob = async job => {
    if (busyRef.current) return;
    setBusy(true); busyRef.current = true; setError(null); setActivity({ phase: 'start', jobId: job.id, model: job.model });
    try {
      const response = await window.media.resumeJob(job.id);
      if (response?.canceled) { setActivity({ phase: 'cancelled', jobId: job.id }); return; }
      if (!response?.ok) throw new Error(response?.error || 'Could not resume this generation.');
      await showVideo(response.path); await loadRecent();
      setActivity({ phase: 'done', jobId: job.id });
    } catch (failure) { setError(failure.message); setActivity({ phase: 'error', jobId: job.id }); }
    finally { busyRef.current = false; setBusy(false); await loadPending(); }
  };

  useEffect(() => {
    const next = videoStateFromImageHandoff(imageHandoff, VIDEO_MODELS_I2V[0].id);
    if (!next) return;
    setAnimate(next.animate);
    setSourceImage(next.sourceImage);
    setPrompt(next.prompt);
    setModel(next.model);
    setCustomModel(next.customModel);
    setSourceImageJobId(next.sourceImageJobId);
    setSourceCollection(next.collection);
    setLibrary(loadCreativeLibrary(window.localStorage));
    setError(null);
    onImageHandoffConsumed?.();
  }, [imageHandoff, onImageHandoffConsumed]);

  const toggleAnimate = (next) => {
    setAnimate(next);
    const list = next ? VIDEO_MODELS_I2V : VIDEO_MODELS_T2V;
    setModel(list[0].id);
    if (!next) { setSourceImage(null); setSourceImageJobId(''); setSourceCollection(''); }
  };

  const chooseImage = async () => {
    const res = await window.media.pickImage();
    if (res.ok) { setSourceImage({ path: res.path, dataUrl: res.dataUrl }); setSourceImageJobId(''); setSourceCollection(''); }
    else if (!res.canceled) setError(res.error);
  };

  const showVideo = async (p) => {
    try {
    const res = await window.media.readFile(p);
    if (!res.ok) { setError(res.error); return; }
    if (previewBlob.current) URL.revokeObjectURL(previewBlob.current);
    previewBlob.current = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }));
    setVideoUrl(previewBlob.current);
    setResultPath(p);
    } catch (failure) { setError(failure.message); }
  };

  const reuseSettings = details => {
    setSourceImageJobId(details.sourceImageJobId || ''); setSourceCollection(details.collection || '');
    setAnimate(details.animate); setSourceImage(details.sourceImage || null);
    setPrompt(details.prompt); setModel(details.model); setCustomModel(details.customModel);
    setAspect(details.aspect); setDuration(details.duration);
  };

  const generate = async () => {
    if (busyRef.current) return;
    const sel = MODELS.find((m) => m.id === model) || MODELS[0];
    const provider = sel.provider;
    const endpoint = model === 'custom' ? customModel.trim() : model;
    if (!prompt.trim() || !endpoint) return;
    if (animate && !sourceImage) { setError('Choose an image to animate first.'); return; }
    setBusy(true); setError(null);
    setSpendApproved(false);
    busyRef.current = true; requestModel.current = endpoint;
    setActivity({ phase: 'preparing' });
    try {
    const params = buildGenerationParams(provider, 'video', {
      prompt: prompt.trim(), aspect,
      durationSeconds: duration === 'auto' ? null : Number(duration),
      image: animate ? sourceImage.dataUrl : null,
    });
    const request = { kind: 'video', provider, model: endpoint, params };
    const authorization = await window.media.authorizeGeneration(request);
    if (!authorization?.ok) throw new Error(authorization?.error || 'Could not authorize this provider request.');
    const res = await window.media.generate({ ...request, authorizationId: authorization.authorizationId });
    if (res?.canceled) { setActivity(current => ({ ...current, phase: 'cancelled' })); return; }
    if (!res.ok) throw new Error(res.error || 'Generation failed');
    const details = { animate, sourceImage, sourceImageJobId, collection:sourceCollection, prompt: prompt.trim(), model, customModel: customModel.trim(), aspect, duration };
    const metadata=saveJobMetadata(window.localStorage,libraryRef.current,'video',res.jobId,{sourceImageJobId:animate?sourceImageJobId:'',collection:sourceCollection});
    setLibrary(metadata.library);
    const persisted = saveGenerationSettings(window.localStorage, 'video', res.jobId, details);
    // Keep the selected source available during this session, but never write
    // its path or base64 bytes to persistent history.
    setSettingsHistory({ ...persisted, [res.jobId]: details });
    await showVideo(res.path); loadRecent();
    setActivity(current => ({ ...current, phase: 'done' }));
    } catch (failure) {
      setError(failure.message || 'Generation failed');
      setActivity(current => ({ ...current, phase: 'error' }));
    } finally { busyRef.current = false; setBusy(false); }
  };

  if (!hasBridge) {
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', color: C.dim }}>
        <h2 style={{ color: C.text, fontSize: 22, fontWeight: 900, marginBottom: 10 }}>Video</h2>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          Cloud video generation runs inside the Vidmyo desktop window (your provider keys are kept
          in the macOS keychain). Open the Vidmyo desktop app to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="cloud-video-studio" style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 22px 60px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <style>{`.cloud-video-studio > div{flex-shrink:0}.cloud-video-studio select{max-width:100%}.cloud-video-studio :focus-visible{outline:2px solid var(--vm-accent);outline-offset:3px}`}</style>
      <div>
        <h2 style={{ color: C.text, fontSize: 28, fontWeight: 700 }}>Video generation</h2>
        <div style={{ color: C.dim, fontSize: 11, marginTop: 2 }}>
          fal.ai / Agnes AI · bring-your-own-key · renders take minutes and are billed per clip by the provider
        </div>
      </div>

      <div style={{ ...card, color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
        <b style={{ color: C.text }}>API generation · separate from subscription agents</b><br/>
        Your prompt and chosen image go to the selected provider. Codex and Claude subscriptions do not cover this call. Cost is unavailable here; check provider pricing before generating. Model-specific options may not be supported by every endpoint.
      </div>
      <GenerationRecovery jobs={pendingJobs} busy={busy} onResume={resumeJob} onCancel={cancelJob} />

      <div style={card}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button style={btn(!animate)} onClick={() => toggleAnimate(false)}>Text to video</button>
          <button style={btn(animate)} onClick={() => toggleAnimate(true)}>Animate an image</button>
        </div>

        {animate && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {sourceImage
              ? <img src={sourceImage.dataUrl} alt="source" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.line}` }} />
              : <div style={{ width: 56, height: 56, borderRadius: 8, border: `1px dashed ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 10 }}>none</div>}
            <button style={btn()} onClick={chooseImage}>{sourceImage ? 'Change image…' : 'Choose image…'}</button>
            {sourceImage && <span style={{ color: C.dim, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>{sourceImage.path.split('/').pop()}</span>}
          </div>
        )}

        {animate&&sourceImageJobId&&<p style={{color:C.dim,fontSize:12,overflowWrap:'anywhere'}}>Source image · {sourceImageJobId}{sourceCollection?` · ${sourceCollection}`:''}. This relationship will be saved with the completed video.</p>}
        <textarea
          aria-label="Video prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={animate ? 'Describe how the image should move…' : 'Describe the clip…'}
          style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 11, padding: 12, fontSize: 13, lineHeight: 1.6, color: C.text, outline: 'none', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Video model" value={model} onChange={(e) => setModel(e.target.value)}
                  style={{ background: 'var(--vm-input)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {model === 'custom' && (
            <input value={customModel} onChange={(e) => setCustomModel(e.target.value)}
                   placeholder="fal-ai/…"
                   style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text, fontFamily: 'ui-monospace, monospace', width: 260 }} />
          )}
          <select aria-label="Video aspect ratio" value={aspect} onChange={(e) => setAspect(e.target.value)}
                  style={{ background: 'var(--vm-input)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {['16:9', '9:16', '1:1'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select aria-label="Video duration" value={duration} onChange={(e) => setDuration(e.target.value)}
                  title="Video length in seconds (Auto = provider default)"
                  style={{ background: 'var(--vm-input)', border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 10px', fontSize: 12, color: C.text }}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d === 'auto' ? 'Auto length' : `${d}s`}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button style={btn(true, !canGenerate)} disabled={!canGenerate} onClick={generate}>
            {busy ? 'Rendering… (minutes)' : 'Generate'}
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12, color: C.text, fontSize: 12, lineHeight: 1.45 }}>
          <input type="checkbox" checked={spendApproved} onChange={event => setSpendApproved(event.target.checked)} />
          Approve one {((MODELS.find(item => item.id === model) || MODELS[0]).provider)} API request. Cost is unknown here; {animate ? 'the prompt and source image leave' : 'the prompt leaves'} this device.
        </label>
        {activity && <div role="status" style={{ color: C.dim, fontSize: 12, marginTop: 12 }}>{busy ? `${activity.phase === 'start' ? 'Provider is generating' : 'Preparing request'} · ${elapsed}s elapsed` : activity.phase === 'done' ? 'Generation completed' : 'Generation stopped'}{activity.jobId ? ` · Job ${activity.jobId}` : ''}{busy && <p>No reliable percentage is supplied by this provider. Do not start a duplicate request.</p>}{busy && activity.jobId && <button type="button" onClick={cancelCurrent} style={{ ...btn(), color: C.bad, padding: '6px 10px' }}>Cancel request</button>}</div>}
        {error && <div role="alert" style={{ color: C.bad, fontSize: 12, marginTop: 8 }}>{error}</div>}
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
          <h3 style={{color:C.text,fontSize:16,marginBottom:12}}>Generation history</h3>
          <LibraryFilter library={library} value={libraryFilter} onChange={setLibraryFilter}/>
          {recent.filter(job=>matchesLibraryFilter(library,'video',job.id,libraryFilter)).map((j) => (
            <div key={j.id} style={{ padding: '12px 0', borderTop: `1px solid ${C.line}` }}>
            <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:10}}>
              <span style={{ color: C.dim, fontSize: 12, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.prompt || j.id}</span>
              {j.artifact && (
                <>
                  <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => showVideo(j.artifact)}>Play</button>
                  <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => window.media.reveal(j.artifact)}>Show</button>
                </>
              )}
              {settingsHistory[j.id] && <button style={{ ...btn(), padding: '4px 10px', fontSize: 11 }} onClick={() => reuseSettings(settingsHistory[j.id])}>Reuse settings</button>}
            </div>
            <LibraryEntry library={library} kind="video" jobId={j.id} onChange={updateMetadata}/>
            <p style={{color:C.dim,fontSize:12,marginTop:8}}>{settingsHistory[j.id]?`${settingsHistory[j.id].model} · ${settingsHistory[j.id].aspect} · ${settingsHistory[j.id].duration==='auto'?'Automatic duration':`${settingsHistory[j.id].duration}s`}`:'Settings unavailable for this older job'} · {j.id}</p>
            </div>
          ))}
          {!recent.some(job=>matchesLibraryFilter(library,'video',job.id,libraryFilter))&&<p style={{color:C.dim,fontSize:12}}>No results match this filter. Choose All results to see your history.</p>}
        </div>
      )}
    </div>
  );
}
