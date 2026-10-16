import { StudioCharacter } from '../../../animation-engine/renderer/StudioCharacter.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ANIMATION_STYLES } from '../../../core/src/animationCatalog.js';
import {
  AUTOMATIC_IMAGE_SOURCES,
  STORY_IMAGE_SOURCES,
  creativeBriefDefaults,
  creativeSectionNumbers,
  mergeCreativeBrief,
} from '../creativeStudioModel.mjs';
import { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from '../../../core/src/kokoroVoices.js';
import './CreativeStudio.css';

const LOCAL_PROVIDERS = [
  { id: 'codex', name: 'Codex', mark: 'CX' },
  { id: 'claude_code', name: 'Claude Code', mark: 'CL' },
  { id: 'gemini', name: 'Gemini CLI', mark: 'GE' },
  { id: 'hermes', name: 'Hermes', mark: 'HE' },
];

const PROGRESS = [
  { id: 'writing', label: 'Write script' },
  { id: 'voiceover', label: 'Create voiceover' },
  { id: 'planning', label: 'Plan scenes' },
  { id: 'images', label: 'Create visuals' },
  { id: 'rendering', label: 'Render video' },
  { id: 'done', label: 'Ready' },
];

const STATE_ORDER = {
  draft: -1, interrupted: -1, error: -1, cancelled: -1, canceled: -1, writing: 0, 'review-script': 0,
  voiceover: 1, 'review-voiceover': 1, preparing: 1, planning: 2,
  images: 3, 'flow-images': 3, rendering: 4, done: 5,
};

function shortDate(value) {
  if (!value) return 'Recently opened';
  try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
  catch { return 'Recently opened'; }
}

function displayError(value, fallback = 'Something went wrong. Try again.') {
  return typeof value === 'string' ? value : value?.message || fallback;
}

function StyleArt({ id }) {
  if (id === 'documentary-map') return <div className="creative-style-art art-map" aria-hidden="true"><i className="art-route" /><i className="art-dot" /></div>;
  if (id === 'paper-stop-motion') return <div className="creative-style-art art-paper" aria-hidden="true"><i className="art-sun" /><i className="art-hill" /><i className="art-hero" /></div>;
  return <div className="creative-style-art art-collage" aria-hidden="true"><i className="art-photo" /><i className="art-type">Ideas in motion</i><i className="art-line" /></div>;
}

function SectionHeading({ number, title, copy, action }) {
  return (
    <div className="creative-card-heading">
      <div><h3 className="creative-card-title">{title}</h3>{copy && <p className="creative-card-copy">{copy}</p>}</div>
      {action || <span className="creative-step" aria-hidden="true">{number}</span>}
    </div>
  );
}

function Segment({ options, value, onChange, label }) {
  return (
    <div className="creative-segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" className="creative-segment" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function GoogleSource({ bridge, templateBridge, brief, setBrief, setMessage, setError }) {
  const [account, setAccount] = useState(null);
  const [files, setFiles] = useState([]);
  const [nextPage, setNextPage] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [selectedTab, setSelectedTab] = useState('');
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState('');
  const request = useRef(0);

  useEffect(() => {
    const source = brief.sourceSheet;
    if (!source?.sheetId) return;
    setSelected(current => current?.id === source.sheetId ? current : {
      id: source.sheetId,
      name: source.spreadsheetTitle || 'Selected spreadsheet',
      ...(source.url ? { url: source.url } : {}),
    });
    setSelectedTab(source.tab || '');
  }, [brief.sourceSheet]);

  const fail = useCallback((value) => setError(displayError(value, 'Google Sheets could not complete that request.')), [setError]);

  const loadAccount = useCallback(async () => {
    if (!bridge?.googleAccount) return;
    const token = ++request.current;
    const res = await bridge.googleAccount();
    if (token !== request.current) return;
    setAccount(res?.ok ? res : { ...(res || {}), connected: false, canConnect: false, hint: res?.error });
  }, [bridge]);

  const setupGoogle = async () => {
    if (!bridge?.googleSetup) return fail('Google setup is unavailable in this build.');
    setBusy('setup'); setError('');
    try { const res = await bridge.googleSetup(); if (res?.canceled) return; if (!res?.ok) return fail(res?.error || 'Google setup could not be completed.'); setAccount(res); setMessage('Google is ready.'); }
    catch (value) { fail(value); } finally { setBusy(''); }
  };

  const disconnectGoogle = async () => {
    if (!bridge?.googleDisconnect) return;
    setBusy('disconnect'); setError('');
    try {
      const res = await bridge.googleDisconnect();
      if (!res?.ok) return fail(res?.error || 'Google could not be disconnected.');
      setAccount({ ...res, connected: false }); setFiles([]); setTabs([]); setRows([]); setSelected(null); setSelectedTab('');
      setBrief(current => ({ ...current, sourceSheet: null })); setMessage('Google disconnected.');
    } catch (value) { fail(value); } finally { setBusy(''); }
  };

  const listSheets = useCallback(async (pageToken = '', append = false) => {
    if (!bridge?.googleSheets) return;
    setBusy('sheets'); setError('');
    const token = ++request.current;
    const res = await bridge.googleSheets(pageToken || undefined);
    if (token !== request.current) return;
    setBusy('');
    if (!res?.ok) return fail(res?.error);
    setFiles(old => append ? [...old, ...(res.files || [])] : (res.files || []));
    setNextPage(res.nextPageToken || null);
  }, [bridge, fail, setError]);

  useEffect(() => { loadAccount(); }, [loadAccount]);
  useEffect(() => { if (account?.connected && files.length === 0) listSheets(); }, [account?.connected, files.length, listSheets]);

  const clearBelowSheet = () => {
    request.current += 1;
    setTabs([]); setSelectedTab(''); setRows([]); setQuery('');
    setBrief(current => ({ ...current, sourceSheet: null }));
  };

  const loadRows = async (selection = selected, tab = selectedTab) => {
    if (!selection || !bridge?.chooseSheet || !bridge?.readSheet) return;
    setBusy('rows'); setError(''); setRows([]);
    const token = ++request.current;
    const chosen = await bridge.chooseSheet({ id: selection.id, url: selection.url, tab });
    if (token !== request.current) return;
    if (!chosen?.ok) { setBusy(''); return fail(chosen?.error); }
    const res = await bridge.readSheet();
    if (token !== request.current) return;
    setBusy('');
    if (!res?.ok) return fail(res?.error);
    setRows(res.rows || []);
    setMessage(`${res.rows?.length || 0} rows loaded${res.via === 'shared-link' ? ' from the shared link' : ''}.`);
  };

  const chooseListedSheet = async file => {
    clearBelowSheet(); setSelected({ id: file.id, name: file.name }); setBusy('tabs'); setError('');
    const token = ++request.current;
    const res = await bridge.sheetTabs(file.id);
    if (token !== request.current) return;
    setBusy('');
    if (!res?.ok) return fail(res?.error);
    setSelected(current => ({ ...current, name: res.title || current.name }));
    setTabs(res.tabs || []);
  };

  const useSharedLink = async () => {
    if (!link.trim()) return fail('Paste a Google Sheets link first.');
    clearBelowSheet(); setBusy('link'); setError('');
    const token = ++request.current;
    const chosen = await bridge.chooseSheet(link.trim());
    if (token !== request.current) return;
    if (!chosen?.ok) { setBusy(''); return fail(chosen?.error); }
    const sheet = { id: chosen.sheetId, name: 'Shared spreadsheet', url: link.trim() };
    setSelected(sheet); setSelectedTab(chosen.tab || '');
    const tabResult = await bridge.sheetTabs(chosen.sheetId);
    if (token !== request.current) return;
    if (tabResult?.ok && tabResult.tabs?.length) {
      setSelected({ ...sheet, name: tabResult.title || sheet.name }); setTabs(tabResult.tabs);
      setBusy('');
      if (chosen.tab) await loadRows(sheet, chosen.tab);
    } else {
      const res = await bridge.readSheet();
      if (token !== request.current) return;
      setBusy('');
      if (!res?.ok) return fail(res?.error || tabResult?.error);
      setRows(res.rows || []);
      setMessage(`${res.rows?.length || 0} rows loaded from the shared link.`);
    }
  };

  const saveTrackerTemplate = async () => {
    if (!templateBridge?.saveTrackerTemplate) return fail('The tracker template is unavailable in this build.');
    setBusy('template'); setError('');
    try {
      const result = await templateBridge.saveTrackerTemplate();
      if (result?.canceled) return;
      if (!result?.ok) return fail(result?.error || 'The tracker template could not be saved.');
      setMessage('Vidmyo Tracker saved. Import the CSV into Google Sheets, then select it here.');
    } catch (value) { fail(value); }
    finally { setBusy(''); }
  };

  const selectRow = row => {
    const details = [row.hook && `Opening hook: ${row.hook}`, (row.topic || row.details) && `Story direction: ${row.topic || row.details}`].filter(Boolean).join('\n\n');
    setBrief(current => ({
      ...current,
      topic: row.title || current.topic,
      details: details || current.details,
      sourceSheet: {
        sheetId: selected?.id,
        spreadsheetTitle: selected?.name,
        tab: selectedTab,
        row: row.row,
        title: row.title,
        status: row.status,
        videoNum: row.videoNum,
        hook: row.hook,
        topic: row.topic || row.details || '',
        description: row.description || row.details || '',
        via: selected?.url ? 'shared-link' : 'google-account',
        ...(selected?.url ? { url: selected.url } : {}),
      },
    }));
    setMessage(`Row ${row.row} selected. You can edit the brief before creating the project.`);
  };

  const filtered = rows.filter(row => `${row.title} ${row.status} ${row.hook} ${row.topic}`.toLowerCase().includes(query.toLowerCase()));
  if (!bridge) return <div className="creative-callout">Google Sheets is available in the Vidmyo desktop app. Open this project there to connect or use a shared link.</div>;

  return (
    <div className="creative-google-panel">
      {brief.sourceSheet && (
        <div className="creative-selection-summary">
          <span className="creative-pill creative-pill-good">Selected</span>
          <span><strong>{brief.sourceSheet.title || `Row ${brief.sourceSheet.row}`}</strong>{brief.sourceSheet.spreadsheetTitle || 'Spreadsheet'}{brief.sourceSheet.tab ? ` · ${brief.sourceSheet.tab}` : ''} · row {brief.sourceSheet.row}</span>
        </div>
      )}
      <div className="creative-account">
        <div className="creative-account-state">
          <span className={`creative-status-dot ${account?.connected ? 'connected' : ''}`} />
          <div className="creative-account-text">
            <strong>{account?.connected ? 'Google connected' : account ? (account.status === 'setup-required' ? 'Google setup required' : 'Google is not connected') : 'Checking Google…'}</strong>
            {account?.connected ? (account.email || 'Connected account') : (account?.hint || account?.error || 'Connect to browse private spreadsheets.')}
          </div>
        </div>
        <div className="creative-row-actions">
        {!account?.connected && (account?.needsSetup || account?.canSetup || account?.status === 'setup-required') && bridge.googleSetup && <button type="button" className="creative-button creative-button-small" disabled={busy === 'setup'} onClick={setupGoogle}>{busy === 'setup' ? 'Setting up…' : 'Configure Google'}</button>}
        {!account?.connected && account?.canConnect && (
          <button type="button" className="creative-button creative-button-small" disabled={busy === 'connect'} onClick={async () => {
            setBusy('connect'); setError('');
            try { const res = await bridge.googleConnect(); if (!res?.ok) return fail(res?.error); setAccount(res); setMessage('Google connected.'); }
            catch (value) { fail(value); } finally { setBusy(''); }
          }}>{busy === 'connect' ? 'Connecting…' : 'Connect Google'}</button>
        )}
        {account?.connected && account.canDisconnect && bridge.googleDisconnect && <button type="button" className="creative-button creative-button-small creative-button-quiet" disabled={busy === 'disconnect'} onClick={disconnectGoogle}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>}
        </div>
      </div>

      <div className="creative-selection-summary">
        <span className="creative-pill">Vidmyo system</span>
        <span><strong>Need a production sheet?</strong> Save the official 21-column tracker, import it into Google Sheets, and plan every video in the same format.</span>
        <button type="button" className="creative-button creative-button-small" disabled={busy === 'template'} onClick={saveTrackerTemplate}>{busy === 'template' ? 'Saving…' : 'Save tracker template'}</button>
      </div>

      {account?.connected && (
        <>
          <label className="creative-field">
            <span className="creative-label">Spreadsheet <span className="creative-hint">Read only</span></span>
            <select className="creative-select" value={selected?.id || ''} disabled={busy === 'sheets'} onChange={e => {
              const file = files.find(item => item.id === e.target.value);
              if (file) chooseListedSheet(file);
              else { clearBelowSheet(); setSelected(null); }
            }}>
              <option value="">{busy === 'sheets' ? 'Loading spreadsheets…' : 'Choose a spreadsheet'}</option>
              {selected?.id && !files.some(file => file.id === selected.id) && <option value={selected.id}>{selected.name}</option>}
              {files.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select>
          </label>
          {nextPage && <button type="button" className="creative-button creative-button-small creative-button-quiet" onClick={() => listSheets(nextPage, true)}>Load more spreadsheets</button>}
        </>
      )}

      <div className="creative-or">or use a shared link</div>
      <div className="creative-field-grid">
        <label className="creative-field">
          <span className="creative-label">Google Sheets link</span>
          <input className="creative-input" value={link} onChange={e => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
        </label>
        <div className="creative-field" style={{ alignSelf: 'end' }}>
          <button type="button" className="creative-button" disabled={busy === 'link'} onClick={useSharedLink}>{busy === 'link' ? 'Opening…' : 'Use shared link'}</button>
        </div>
      </div>

      {(tabs.length > 0 || selectedTab) && (
        <div className="creative-field-grid">
          <label className="creative-field">
            <span className="creative-label">Worksheet</span>
            <select className="creative-select" value={selectedTab} onChange={e => {
              request.current += 1;
              setSelectedTab(e.target.value);
              setRows([]);
              setQuery('');
              setBrief(current => ({ ...current, sourceSheet: null }));
            }}>
              <option value="">Choose a worksheet</option>
              {selectedTab && !tabs.some(tab => tab.title === selectedTab) && <option value={selectedTab}>{selectedTab}</option>}
              {tabs.map(tab => <option key={tab.sheetId} value={tab.title}>{tab.title}</option>)}
            </select>
          </label>
          <div className="creative-field" style={{ alignSelf: 'end' }}>
            <button type="button" className="creative-button" disabled={!selectedTab || busy === 'rows'} onClick={() => loadRows()}>{busy === 'rows' ? 'Loading rows…' : 'Load rows'}</button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <label className="creative-field">
            <span className="creative-label">Choose a row <span className="creative-hint">Up to 1,000 rows are read</span></span>
            <input className="creative-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search title, hook, or status" />
          </label>
          <div className="creative-row-list" role="listbox" aria-label="Spreadsheet rows">
            {filtered.map(row => (
              <button key={row.row} type="button" className="creative-list-item" role="option" aria-selected={brief.sourceSheet?.row === row.row} onClick={() => selectRow(row)}>
                <span className="creative-list-main"><span className="creative-list-title">{row.title}</span><span className="creative-list-meta">Row {row.row}{row.hook ? ` · ${row.hook}` : ''}</span></span>
                <span className={`creative-pill ${String(row.status).toLowerCase() === 'planned' ? 'creative-pill-good' : ''}`}>{row.status || 'No status'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProgressCard({ snapshot, pending, logs, onStart, onApprove, onImportFlowImages, onCancel, onReveal, error }) {
  const manifest = snapshot?.manifest || {};
  const production = manifest.production || { state: 'draft' };
  const state = production.state || 'draft';
  const current = STATE_ORDER[state] ?? -1;
  const running = pending === 'start' || snapshot?.busy;
  const reviewScript = state === 'review-script';
  const reviewVoice = state === 'review-voiceover';
  const awaitingFlowImages = state === 'flow-images';
  const isError = state === 'error' || state === 'interrupted' || state === 'cancelled' || state === 'canceled';
  const isDone = state === 'done';
  const completed = new Set();
  if (manifest.script) completed.add('writing');
  if (manifest.brief?.narration === false || manifest.voiceover?.artifact) completed.add('voiceover');
  if (production.planDone || production.assetsDone) completed.add('planning');
  if (production.assetsDone) completed.add('images');
  if (production.output || manifest.renders?.some(render => render.finalized)) completed.add('rendering');

  return (
    <div className="creative-card">
      <SectionHeading number="" title="Production" copy={production.message || (isDone ? 'Your video is ready.' : 'Progress is saved in this project folder.')} action={state !== 'draft' ? <span className={`creative-pill ${isDone ? 'creative-pill-good' : ''}`}>{state.replace(/-/g, ' ')}</span> : undefined} />
      <div className="creative-progress">
        {PROGRESS.map((step, index) => {
          const skippedVoice = manifest.brief?.narration === false && step.id === 'voiceover';
          const done = isDone || completed.has(step.id) || index < current || (index === current && (reviewScript || reviewVoice));
          const active = !skippedVoice && index === current && !isDone && !isError;
          return (
            <div key={step.id} className={`creative-progress-row ${done ? 'done' : ''} ${active ? 'current' : ''}`}>
              <span className="creative-progress-mark">{skippedVoice ? '–' : done ? '✓' : index + 1}</span>
              <div><div className="creative-progress-name">{step.label}{skippedVoice ? ' · skipped' : ''}</div>{active && production.message && <div className="creative-progress-message">{production.message}</div>}</div>
            </div>
          );
        })}
      </div>
      {logs.length > 0 && <div className="creative-log" aria-live="polite">{logs.slice(-5).map((entry, i) => <div key={`${entry.message}-${i}`}>{entry.message}</div>)}</div>}
      {(error || isError) && <div className="creative-callout creative-callout-error" role="alert" style={{ marginTop: 12 }}>{error || production.message || 'Production stopped. Your completed work is saved.'}</div>}
      <div className="creative-footer-action" style={{ marginTop: 14 }}>
        {state === 'draft' && <button type="button" className="creative-button creative-button-primary" disabled={running} onClick={() => onStart(false)}>{running ? 'Starting…' : 'Create video'}</button>}
        {(reviewScript || reviewVoice) && <button type="button" className="creative-button creative-button-primary" disabled={running} onClick={onApprove}>{running ? 'Continuing…' : 'Approve & continue'}</button>}
        {awaitingFlowImages && <>
          <div className="creative-flow-handoff"><strong>Google Flow + Curio Flow Queue</strong><span>Open the Chrome Extension and import <code>{production.flowQueue?.fileName || 'flow-image-queue.json'}</code>. It downloads images as s001, s002… Then import that images folder here.</span></div>
          <button type="button" className="creative-button creative-button-primary" disabled={running} onClick={onImportFlowImages}>Import generated Flow images</button>
          {production.assetsDone && <button type="button" className="creative-button" disabled={running} onClick={() => onStart(false)}>Continue & render</button>}
        </>}
        {isError && <button type="button" className="creative-button creative-button-primary" disabled={running} onClick={() => onStart(false)}>{running ? 'Retrying…' : 'Retry from saved progress'}</button>}
        {running && <button type="button" className="creative-button creative-button-danger" onClick={onCancel}>Stop production</button>}
        <button type="button" className="creative-button creative-button-quiet" onClick={onReveal}>Reveal project folder</button>
      </div>
    </div>
  );
}

export default function CreativeStudio({ kind = 'story', onOpenSettings, onNavigateAgents, initialHandoff = null, onHandoffConsumed }) {
  const isStory = kind === 'story';
  const hasCreative = typeof window !== 'undefined' && !!window.creative?.isElectron;
  const creative = hasCreative ? window.creative : null;
  const storyBridge = typeof window !== 'undefined' && window.story?.isElectron ? window.story : null;
  const [brief, setBrief] = useState(() => creativeBriefDefaults(kind));
  const [sourceMode, setSourceMode] = useState('idea');
  const [snapshot, setSnapshot] = useState(null);
  const [recents, setRecents] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [logs, setLogs] = useState([]);
  const [scriptDraft, setScriptDraft] = useState('');
  const [voicebox, setVoicebox] = useState(null);
  const [channelSource, setChannelSource] = useState(null);
  const activeDir = useRef(null);
  const inFlight = useRef(false);
  const progressRefresh = useRef(null);
  const consumedHandoff = useRef(null);

  const imageSources = useMemo(() => isStory ? STORY_IMAGE_SOURCES : AUTOMATIC_IMAGE_SOURCES, [isStory]);
  const imageSource = imageSources.find(source => source.id === brief.imageSource) || imageSources[0];

  useEffect(() => {
    if (!initialHandoff?.brief || initialHandoff.section !== kind || consumedHandoff.current === initialHandoff) return;
    consumedHandoff.current = initialHandoff;
    const next = mergeCreativeBrief(kind, initialHandoff.brief);
    setBrief(next);
    setScriptDraft(next.script || '');
    setSourceMode(next.sourceSheet ? 'sheet' : 'idea');
    setSnapshot(null);
    setError('');
    setMessage('Video loaded from the channel queue. Review the brief, then create its project.');
    setChannelSource(initialHandoff.workspaceDir ? { workspaceDir: initialHandoff.workspaceDir, videoId: initialHandoff.videoId } : null);
    onHandoffConsumed?.();
  }, [initialHandoff, kind, onHandoffConsumed]);

  const refreshRecents = useCallback(async () => {
    if (!creative) return;
    try {
      const res = await creative.recent();
      if (!res?.ok) { setError(displayError(res?.error, 'Recent projects could not be loaded.')); return; }
      setRecents((res.projects || []).filter(item => item.kind === kind));
    } catch (value) {
      setError(displayError(value, 'Recent projects could not be loaded.'));
    }
  }, [creative, kind]);

  const applySnapshot = useCallback(value => {
    if (!value?.ok) { setError(displayError(value?.error)); return false; }
    const projectKind = value.manifest?.brief?.kind;
    if (projectKind && projectKind !== kind) {
      setError(projectKind === 'animation'
        ? 'This is an Animations project. Open it from the Animations workspace.'
        : 'This is a Stickman project. Open it from the Stickman workspace.');
      return false;
    }
    setSnapshot(value); activeDir.current = value.dir;
    const next = mergeCreativeBrief(kind, value.manifest?.brief);
    setBrief(next); setScriptDraft(value.manifest?.script || next.script || '');
    setSourceMode(next.sourceSheet ? 'sheet' : 'idea');
    setError(''); setMessage('');
    return true;
  }, [kind]);

  useEffect(() => {
    if (!creative) return;
    refreshRecents();
    const unsubscribe = creative.onProgress?.(event => {
      if (!event?.dir || event.dir !== activeDir.current) return;
      setLogs(old => [...old.slice(-12), { message: event.message || 'Working…' }]);
      clearTimeout(progressRefresh.current);
      progressRefresh.current = setTimeout(async () => {
        const dir = event.dir;
        try {
          const latest = await creative.get(dir);
          if (dir === activeDir.current && latest?.ok) setSnapshot(latest);
        } catch { /* The start response will surface a durable failure. */ }
      }, 120);
    });
    return () => {
      clearTimeout(progressRefresh.current);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [creative, refreshRecents]);

  useEffect(() => {
    if (!storyBridge?.getImageConfig) return;
    let current = true;
    storyBridge.getImageConfig().then(result => {
      if (!current || !result?.ok || activeDir.current) return;
      const source = (isStory ? STORY_IMAGE_SOURCES : AUTOMATIC_IMAGE_SOURCES).find(item => item.id === result.imageSource);
      if (!source) return;
      const model = source.models.some(item => item.id === result.imageModel)
        ? result.imageModel
        : source.models[0]?.id || '';
      setBrief(value => ({ ...value, imageSource: source.id, imageModel: model }));
    }).catch(() => {});
    return () => { current = false; };
  }, [storyBridge, isStory]);

  useEffect(() => {
    if (!creative || typeof window === 'undefined') return;
    const key = 'vidmyo_story_recent_migrated_to_disk_v1';
    let storage;
    try { storage = window.localStorage; } catch { return; }
    if (storage.getItem(key)) return;
    let legacy = [];
    try { legacy = JSON.parse(storage.getItem('vidmyo_story_recent') || '[]'); } catch { legacy = []; }
    (async () => {
      for (const item of legacy.slice(0, 30)) if (item?.dir) { try { await creative.open(item.dir); } catch { /* Invalid old entries remain in the source list. */ } }
      try { storage.setItem(key, new Date().toISOString()); } catch { /* Disk recents still work. */ }
      refreshRecents();
    })();
  }, [creative, refreshRecents]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.agents?.isElectron) { setAgentsLoaded(true); return; }
    window.agents.detect().then(res => { if (res?.ok) setAgents(res.agents || []); setAgentsLoaded(true); }).catch(() => setAgentsLoaded(true));
  }, []);

  useEffect(() => {
    if (!creative?.voiceboxStatus) return;
    let current = true;
    creative.voiceboxStatus().then(result => { if (current) setVoicebox(result || { ok: false, available: false }); }).catch(value => { if (current) setVoicebox({ ok: false, available: false, error: displayError(value) }); });
    return () => { current = false; };
  }, [creative]);

  const refreshVoicebox = async () => {
    if (!creative?.voiceboxStatus) return;
    try { setVoicebox(await creative.voiceboxStatus()); }
    catch (value) { setVoicebox({ ok: false, available: false, error: displayError(value) }); }
  };

  const setField = (field, value) => setBrief(current => ({ ...current, [field]: value }));
  const setProvider = id => setBrief(current => ({ ...current, provider: { ...current.provider, id } }));
  const selectedAgent = agents.find(agent => agent.id === brief.provider.id);
  const selectedAgentReady = brief.provider.id === 'openrouter' || !!(selectedAgent?.installed && selectedAgent?.authed && selectedAgent?.subscriptionReady !== false);

  const validate = () => {
    if (sourceMode === 'sheet' && !brief.sourceSheet) return 'Choose a Google Sheets row, or switch to My idea.';
    if (!brief.topic.trim()) return 'Add a topic or title.';
    const duration = Number(brief.durationSec);
    if (!Number.isFinite(duration) || duration < 5 || duration > 900) return 'Duration must be between 5 seconds and 15 minutes.';
    if (!selectedAgentReady) return 'Choose a connected agent, or use OpenRouter.';
    if (brief.provider.id === 'openrouter' && !brief.provider.model.trim().includes('/')) return 'Enter an OpenRouter model in provider/model format.';
    if (brief.narration && brief.voiceProvider === 'kokoro' && !/^(english|en)(?:\b|[-_])/i.test(brief.language.trim())) return `${brief.language || 'This language'} narration is not available in Kokoro. Choose ElevenLabs, Voicebox, choose English, or turn narration off.`;
    if (brief.narration && brief.voiceProvider === 'voicebox' && (!voicebox?.available || !voicebox.voices?.some(voice => voice.id === brief.voiceboxVoiceId))) return voicebox?.error || 'Choose an available Voicebox voice, or select another voice engine.';
    if (brief.style !== 'documentary-map' && !imageSource) return 'Choose an image provider.';
    return '';
  };

  const reset = () => {
    if (snapshot?.busy || pending === 'start') return;
    activeDir.current = null; setSnapshot(null); setBrief(creativeBriefDefaults(kind)); setSourceMode('idea'); setLogs([]); setError(''); setMessage(''); setScriptDraft(''); setChannelSource(null);
  };

  const createProject = async () => {
    if (!creative || inFlight.current) return;
    const problem = validate(); if (problem) { setError(problem); return; }
    inFlight.current = true; setPending('create'); setError(''); setMessage('');
    try {
      const picked = await creative.pickRoot();
      if (picked?.canceled) return;
      if (!picked?.ok) { setError(displayError(picked?.error, 'Choose a folder where Vidmyo can save the project.')); return; }
      const res = await creative.create({ root: picked.dir, brief: { ...brief, durationSec: Number(brief.durationSec), script: scriptDraft || brief.script } });
      if (applySnapshot(res)) {
        let linked = true;
        if (channelSource?.workspaceDir && typeof window !== 'undefined' && window.channels?.linkProduction) {
          const result = await window.channels.linkProduction(channelSource.workspaceDir, channelSource.videoId, res.manifest?.id);
          linked = !!result?.ok;
        }
        setMessage(linked ? 'Project created. Review your choices, then create the video.' : 'Project created, but its channel status could not be updated. Reopen the channel to retry.');
        await refreshRecents();
      }
    } catch (value) { setError(displayError(value)); }
    finally { setPending(''); inFlight.current = false; }
  };

  const openProject = async dir => {
    if (!creative || inFlight.current) return;
    inFlight.current = true; setPending('open'); setError('');
    try {
      const res = await creative.open(dir);
      if (res?.canceled) return;
      if (applySnapshot(res)) { setLogs([]); await refreshRecents(); }
    } catch (value) { setError(displayError(value, 'That folder is not a Stickman or Animation project.')); }
    finally { setPending(''); inFlight.current = false; }
  };

  const saveProject = async extra => {
    if (!creative || !snapshot?.dir) return null;
    if (sourceMode === 'sheet' && !brief.sourceSheet) { setError('Choose a Google Sheets row, or switch to My idea.'); return null; }
    try {
      const next = { ...brief, ...extra, durationSec: Number(brief.durationSec), script: extra?.script ?? scriptDraft ?? brief.script };
      const res = await creative.save(snapshot.dir, next);
      if (!res?.ok) { setError(displayError(res?.error)); return null; }
      applySnapshot(res); await refreshRecents(); return res;
    } catch (value) {
      setError(displayError(value, 'Changes could not be saved.'));
      return null;
    }
  };

  const startProduction = async approve => {
    if (!creative || !snapshot?.dir || inFlight.current) return;
    const problem = validate(); if (problem) { setError(problem); return; }
    inFlight.current = true; setPending('start'); setError(''); setMessage('');
    try {
      const saved = await saveProject({ script: scriptDraft });
      if (!saved) return;
      const res = await creative.start(snapshot.dir, approve ? { approve: true } : {});
      if (!res?.ok) {
        const failure = displayError(res?.error);
        try {
          const latest = await creative.get(snapshot.dir);
          if (latest?.ok) setSnapshot(latest);
        } catch { /* Keep the last usable snapshot. */ }
        setError(failure);
      } else {
        applySnapshot(res);
      }
      await refreshRecents();
    } catch (value) {
      const failure = displayError(value);
      try {
        const latest = await creative.get(snapshot.dir);
        if (latest?.ok) setSnapshot(latest);
      } catch { /* Keep the last usable snapshot. */ }
      setError(failure);
    }
    finally { setPending(''); inFlight.current = false; }
  };

  const cancelProduction = async () => {
    if (!creative || !snapshot?.dir) return;
    try {
      const res = await creative.cancel(snapshot.dir);
      if (!res?.ok) setError(displayError(res?.error)); else setMessage('Stopping after the current operation. Completed work stays saved.');
    } catch (value) {
      setError(displayError(value, 'Production could not be stopped.'));
    }
  };

  const revealProject = async () => {
    if (!creative || !snapshot?.dir) return;
    try {
      const res = await creative.reveal(snapshot.dir);
      if (!res?.ok) setError(displayError(res?.error, 'The project folder could not be revealed.'));
    } catch (value) {
      setError(displayError(value, 'The project folder could not be revealed.'));
    }
  };

  const importFlowImages = async () => {
    if (!creative?.importFlowImages || !snapshot?.dir || inFlight.current) return;
    inFlight.current = true; setPending('flow-import'); setError('');
    try {
      const res = await creative.importFlowImages(snapshot.dir);
      if (res?.canceled) return;
      if (!applySnapshot(res)) return;
      setMessage(res.manifest?.production?.message || 'Flow images imported.');
    } catch (value) { setError(displayError(value, 'Flow images could not be imported.')); }
    finally { setPending(''); inFlight.current = false; }
  };

  const state = snapshot?.manifest?.production?.state || 'draft';
  const atScriptReview = state === 'review-script';
  const atVoiceReview = state === 'review-voiceover';
  const style = ANIMATION_STYLES.find(item => item.id === brief.style) || ANIMATION_STYLES[0];
  const sectionNumbers = creativeSectionNumbers(kind, brief.style);

  return (
    <div className="creative-studio">
      <div className="creative-frame">
        <header className="creative-header">
          <div className="creative-title-wrap">
            <div className="creative-kicker">{isStory ? 'Stickman studio' : 'Motion design studio'}</div>
            <h1 className="creative-title">{isStory ? 'Turn an idea into a complete story.' : 'Give your story a visual rhythm.'}</h1>
            <p className="creative-lede">{isStory ? 'Shape the brief, choose who writes it, and let Vidmyo carry it through narration, scenes, and final video.' : 'Choose a treatment, describe the motion, and let Vidmyo plan and render the full animation.'}</p>
          </div>
          <div className="creative-header-actions">
            <button type="button" className="creative-button" disabled={snapshot?.busy || pending === 'start'} onClick={reset}>New video</button>
            <button type="button" className="creative-button" disabled={!creative || !!pending || snapshot?.busy} onClick={() => openProject()}>{pending === 'open' ? 'Opening…' : 'Open existing'}</button>
          </div>
        </header>

        {!hasCreative && <div className="creative-callout creative-callout-warning" style={{ marginBottom: 16 }}><strong>Open Vidmyo desktop to create or open projects.</strong> You can explore and fill this intake in the browser; project folders and production run through the desktop app.</div>}
        {snapshot && (
          <div className="creative-project-bar">
            <div className="creative-project-path"><strong>{snapshot.manifest?.brief?.topic || 'Creative project'}</strong>{snapshot.dir}</div>
            <div className="creative-row-actions">
              <button type="button" className="creative-button creative-button-small" disabled={pending === 'save' || snapshot.busy} onClick={async () => { setPending('save'); try { if (await saveProject()) setMessage('Changes saved.'); } finally { setPending(''); } }}>{pending === 'save' ? 'Saving…' : 'Save changes'}</button>
              <button type="button" className="creative-button creative-button-small creative-button-quiet" onClick={revealProject}>Reveal folder</button>
            </div>
          </div>
        )}

        {(error || message) && <div className={`creative-callout ${error ? 'creative-callout-error' : ''}`} role={error ? 'alert' : 'status'} style={{ marginBottom: 16 }}>{error || message}</div>}

        <div className="creative-grid">
          <div className="creative-column">
            {atScriptReview && (
              <section className="creative-card">
                <h2 className="creative-review-title">Review the script</h2>
                <p className="creative-review-copy">Edit anything that should change. Approving saves this version and continues automatically.</p>
                <textarea className="creative-textarea creative-textarea-script" aria-label="Script" value={scriptDraft} onChange={e => setScriptDraft(e.target.value)} />
              </section>
            )}
            {atVoiceReview && (
              <section className="creative-card">
                <h2 className="creative-review-title">Listen to the voiceover</h2>
                <p className="creative-review-copy">If it sounds right, continue to scene planning and production.</p>
                {snapshot.voiceUrl ? <audio className="creative-audio" controls preload="metadata" src={snapshot.voiceUrl} /> : <div className="creative-callout">The voice preview is still being prepared. Reopen this project to refresh it.</div>}
              </section>
            )}

            {!isStory && (
              <section className="creative-card">
                <SectionHeading number={sectionNumbers.style} title="Choose a visual treatment" copy="Each card previews the motion language. Your brief and generated assets determine the final scenes." />
                <div className="creative-style-grid">
                  {ANIMATION_STYLES.map(item => (
                    <button key={item.id} type="button" className="creative-style-card" style={{ '--style-accent': item.accent }} aria-pressed={brief.style === item.id} onClick={() => {
                      setField('style', item.id);
                      if (item.id === 'paper-stop-motion' && !snapshot) setField('narration', false);
                    }}>
                      <StyleArt id={item.id} />
                      <span className="creative-style-copy"><span className="creative-style-name">{item.name}</span><span className="creative-style-description">{item.description}</span></span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="creative-card">
              <SectionHeading number={sectionNumbers.brief} title={isStory ? 'Start with your story' : 'Describe the animation'} copy={isStory ? 'Write your own idea or select a row from Google Sheets. Both become the same editable brief.' : `Your topic and direction will be interpreted through ${style.name.toLowerCase()}.`} />
              {
                <div className="creative-source-tabs">
                  <Segment label={`${isStory ? 'Stickman' : 'Animation'} source`} value={sourceMode} options={[{ value: 'idea', label: 'My idea' }, { value: 'sheet', label: 'Google Sheets' }]} onChange={value => { setSourceMode(value); setError(''); if (value === 'idea') setField('sourceSheet', null); }} />
                </div>
              }
              {sourceMode === 'sheet' && <GoogleSource bridge={storyBridge} templateBridge={creative} brief={brief} setBrief={setBrief} setMessage={setMessage} setError={setError} />}
              {(!isStory || sourceMode === 'idea' || brief.sourceSheet) && (
                <>
                  <label className="creative-field">
                    <span className="creative-label">Topic or working title <span className="creative-hint">Required</span></span>
                    <input className="creative-input" value={brief.topic} onChange={e => setField('topic', e.target.value)} placeholder={isStory ? 'Why your brain wakes you at 2 a.m.' : 'How cities learned to grow upward'} />
                  </label>
                  <label className="creative-field">
                    <span className="creative-label">{isStory ? 'Brief' : 'Visual and motion direction'} <span className="creative-hint">Audience, angle, tone, key moments</span></span>
                    <textarea className="creative-textarea" value={brief.details} onChange={e => setField('details', e.target.value)} placeholder={isStory ? 'Explain the audience, angle, tone, facts to cover, and closing call to action.' : 'Describe the story arc, objects, places, transitions, pace, and any must-show moments.'} />
                  </label>
                </>
              )}
            </section>

            <section className="creative-card">
              <SectionHeading number={sectionNumbers.format} title="Set the format" copy="Duration and orientation are independent, so any treatment can become a short or long video." />
              <div className="creative-field-grid">
                <div className="creative-field">
                  <span className="creative-label">Orientation</span>
                  <Segment label="Video orientation" value={brief.aspect} options={[{ value: '16:9', label: 'Landscape' }, { value: '9:16', label: 'Portrait' }]} onChange={value => setField('aspect', value)} />
                </div>
                <label className="creative-field">
                  <span className="creative-label">Duration <span className="creative-hint">seconds</span></span>
                  <input className="creative-input" type="number" min="5" max="900" step="1" value={brief.durationSec} onChange={e => setField('durationSec', e.target.value)} />
                </label>
              </div>
              {!isStory && (
                <div className="creative-row-actions" style={{ marginTop: 10 }}>
                  <button type="button" className="creative-button creative-button-small creative-button-quiet" onClick={() => setField('durationSec', 30)}>Short · 30s</button>
                  <button type="button" className="creative-button creative-button-small creative-button-quiet" onClick={() => setField('durationSec', 480)}>Long · 8 min</button>
                </div>
              )}
              {isStory && (
                <div className="creative-field" style={{ marginTop: 14 }}>
                  <span className="creative-label">Characters</span>
                  <Segment label="Character animation" value={brief.characterAnimation || 'static'} options={[{value:'static', label:'Not animated'}, {value:'animated', label:'Animated (beta)'}]} onChange={value => setField('characterAnimation', value)} />
                  {brief.characterAnimation === 'animated' && <div style={{marginTop:12}}>
                    <span className="creative-label">Character design</span>
                    <Segment label="Character design" value={brief.characterDesign || 'classic'} options={[{value:'studio',label:'Studio cast'},{value:'classic',label:'Classic figures'}]} onChange={value => setField('characterDesign',value)}/>
                    {brief.characterDesign === 'studio' && <svg viewBox="0 0 600 270" role="img" aria-label="Studio cast: consistent illustrated characters" style={{width:'100%',maxHeight:220,background:'#f5f0e6',borderRadius:12,marginTop:12}}>
                      {['host','guest','guide'].map((id,i)=><StudioCharacter key={id} character={{id,x:.2+i*.3,endX:.2+i*.3,y:.94,scale:.84,action:'idle',expression:'happy',facing:'right',shirt:['blue','red','green'][i],skin:['paper','medium','dark'][i]}} width={600} height={270}/>)}</svg>}
                    <p className="creative-card-copy">Experimental character stories with a consistent cast and simple gestures. Review the character movement before using the result.</p>
                  </div>}
                  <p className="creative-card-copy">{brief.characterAnimation === 'animated'
                    ? 'Beta for stories where the characters act. Figures can gesture, blink and move against still backgrounds. Narrator-led explainers usually work better with illustrated scenes.'
                    : 'Illustrated scenes with gentle camera movement and transitions. The established choice for narrator-led videos; characters stay in their drawn poses.'}</p>
                </div>
              )}
              <div className="creative-field-grid" style={{ marginTop: 14 }}>
                <label className="creative-field">
                  <span className="creative-label">Language</span>
                  <select className="creative-select" value={brief.language} onChange={e => {
                    const language = e.target.value;
                    setBrief(current => ({
                      ...current,
                      language,
                      voiceProvider: language === 'Polish' && current.voiceProvider === 'kokoro' ? 'elevenlabs' : current.voiceProvider,
                    }));
                  }}>
                    <option>English</option>
                    <option>Polish</option>
                  </select>
                </label>
                <div className="creative-field">
                  <span className="creative-label">Narration</span>
                  <Segment label="Narration" value={brief.narration ? 'on' : 'off'} options={[{ value: 'on', label: 'With voice' }, { value: 'off', label: 'No voice' }]} onChange={value => setBrief(current => ({ ...current, narration: value === 'on', reviewVoiceover: value === 'on' ? current.reviewVoiceover : false }))} />
                </div>
              </div>
              {brief.narration && (
                <div className="creative-field-grid" style={{ marginTop: 14 }}>
                  <label className="creative-field">
                    <span className="creative-label">Voice engine</span>
                    <select className="creative-select" value={brief.voiceProvider} onChange={e => setField('voiceProvider', e.target.value)}>
                      <option value="kokoro">Kokoro · local English</option>
                      <option value="voicebox" disabled={!voicebox?.available}>Voicebox · local profiles{voicebox?.available ? '' : ' (unavailable)'}</option>
                      <option value="elevenlabs">ElevenLabs · multilingual API</option>
                    </select>
                  </label>
                  <div className="creative-callout creative-voice-note">
                    {brief.voiceProvider === 'voicebox'
                      ? <>{voicebox?.available ? 'Choose a loaded local Voicebox profile below.' : (voicebox?.error || 'Voicebox is not available on this installation.')}</>
                      : brief.voiceProvider === 'elevenlabs'
                      ? <>Uses your ElevenLabs key for multilingual narration. {onOpenSettings && <button type="button" className="creative-button creative-button-small" onClick={onOpenSettings}>Open Settings</button>}</>
                      : 'Runs locally and currently supports English voices.'}
                  </div>
                </div>
              )}
              {brief.narration && brief.voiceProvider === 'kokoro' && (
                <label className="creative-field" style={{ marginTop: 12 }}>
                  <span className="creative-label">Kokoro voice</span>
                  <select className="creative-select" value={brief.kokoroVoiceId || DEFAULT_KOKORO_VOICE} onChange={e => setField('kokoroVoiceId', e.target.value)}>
                    {KOKORO_VOICES.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                  </select>
                </label>
              )}
              {brief.narration && brief.voiceProvider === 'voicebox' && voicebox?.available && (
                <label className="creative-field" style={{ marginTop: 12 }}>
                  <span className="creative-label">Voicebox profile</span>
                  <select className="creative-select" value={brief.voiceboxVoiceId || ''} onChange={e => setField('voiceboxVoiceId', e.target.value)}>
                    <option value="">Choose a voice</option>
                    {(voicebox.voices || []).map(voice => <option key={voice.id} value={voice.id}>{voice.name || voice.id}</option>)}
                  </select>
                  <button type="button" className="creative-button creative-button-small" onClick={refreshVoicebox}>Refresh voices</button>
                </label>
              )}
              {brief.narration && voicebox && !voicebox.available && (
                <div className="creative-callout creative-callout-warning" style={{ marginTop: 12 }}>
                  Voicebox is unavailable: {voicebox.error || 'no local profiles were found.'}
                  {creative?.voiceboxStatus && <button type="button" className="creative-button creative-button-small" style={{ marginLeft: 8 }} onClick={refreshVoicebox}>Check again</button>}
                </div>
              )}
              {brief.narration && brief.voiceProvider === 'kokoro' && brief.language !== 'English' && <div className="creative-callout creative-callout-warning" style={{ marginTop: 12 }}>Kokoro currently supports English. Choose ElevenLabs for Polish narration, choose English, or turn narration off.</div>}
              {!isStory && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ color: 'var(--vm-muted)', fontSize: 11, cursor: 'pointer' }}>I already have a script</summary>
                  <label className="creative-field" style={{ marginTop: 10 }}><span className="creative-label">Supplied script <span className="creative-hint">Optional</span></span><textarea className="creative-textarea" value={scriptDraft} onChange={e => setScriptDraft(e.target.value)} placeholder="Paste the script here. Vidmyo will use it as written." /></label>
                </details>
              )}
            </section>

            <section className="creative-card">
              <SectionHeading number={sectionNumbers.director} title="Choose your director" copy="Use a connected local agent, or an OpenRouter model configured in Settings." />
              <div className="creative-provider-list">
                {LOCAL_PROVIDERS.map(provider => {
                  const found = agents.find(agent => agent.id === provider.id);
                  const ready = !!(found?.installed && found?.authed && found?.subscriptionReady !== false);
                  return (
                    <button key={provider.id} type="button" className="creative-provider" aria-pressed={brief.provider.id === provider.id} disabled={agentsLoaded && !ready} onClick={() => setProvider(provider.id)}>
                      <span className="creative-provider-mark">{provider.mark}</span>
                      <span><span className="creative-provider-name">{provider.name}</span><span className="creative-provider-state">{!agentsLoaded ? 'Checking…' : ready ? 'Connected' : found?.installed ? 'Sign in from Agents' : 'Not detected'}</span></span>
                    </button>
                  );
                })}
                <button type="button" className="creative-provider" aria-pressed={brief.provider.id === 'openrouter'} onClick={() => setProvider('openrouter')}>
                  <span className="creative-provider-mark">OR</span><span><span className="creative-provider-name">OpenRouter</span><span className="creative-provider-state">Uses your API key</span></span>
                </button>
              </div>
              {brief.provider.id === 'openrouter' && (
                <label className="creative-field" style={{ marginTop: 13 }}><span className="creative-label">OpenRouter model</span><input className="creative-input" value={brief.provider.model} onChange={e => setBrief(current => ({ ...current, provider: { ...current.provider, model: e.target.value } }))} placeholder="openai/gpt-5.1" /></label>
              )}
              {!selectedAgentReady && brief.provider.id !== 'openrouter' && <div className="creative-callout" style={{ marginTop: 12 }}>Connect this agent in Agents, or choose another director. {onNavigateAgents && <button type="button" className="creative-button creative-button-small" style={{ marginLeft: 8 }} onClick={onNavigateAgents}>Open Agents</button>}</div>}
            </section>

            {brief.style !== 'documentary-map' && (
              <section className="creative-card">
                <SectionHeading number={sectionNumbers.imageCreation} title="Choose image creation" copy={isStory ? 'Use a connected image API, or prepare a free Google Flow queue for the Curio Chrome Extension.' : 'Scene images use a separate provider and its saved key.'} />
                <div className="creative-field-grid">
                  <label className="creative-field">
                    <span className="creative-label">Image provider</span>
                    <select className="creative-select" value={imageSource?.id || ''} onChange={e => {
                      const next = imageSources.find(source => source.id === e.target.value); setBrief(current => ({ ...current, imageSource: e.target.value, imageModel: next?.models?.[0]?.id || '' }));
                    }}>{imageSources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select>
                  </label>
                  {!imageSource?.manual && <label className="creative-field">
                    <span className="creative-label">Image model</span>
                    <select className="creative-select" value={brief.imageModel || imageSource?.models?.[0]?.id || ''} onChange={e => setField('imageModel', e.target.value)}>{(imageSource?.models || []).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select>
                  </label>}
                </div>
                <div className="creative-callout" style={{ marginTop: 12 }}>{imageSource?.manual ? <>Vidmyo will write a queue JSON after the script, voice and scene plan are ready. Open Curio Flow Queue in Chrome and import that file; then bring the downloaded sNNN images back to this project.</> : <>{imageSource?.note || 'This provider uses the key stored in Settings.'} {onOpenSettings && !imageSource?.subscription && <button type="button" className="creative-button creative-button-small" style={{ marginLeft: 8 }} onClick={onOpenSettings}>Open Settings</button>}</>}</div>
              </section>
            )}

            <section className="creative-card">
              <SectionHeading number={sectionNumbers.reviewStops} title="Choose review stops" copy="Production runs automatically. Pause only where you want a final say." />
              <div className="creative-checks">
                <label className="creative-check"><input type="checkbox" checked={brief.reviewScript} onChange={e => setField('reviewScript', e.target.checked)} /><span><strong>Review script</strong>Edit the writing before voice and visuals begin.</span></label>
                <label className="creative-check"><input type="checkbox" checked={brief.reviewVoiceover} disabled={!brief.narration} onChange={e => setField('reviewVoiceover', e.target.checked)} /><span><strong>Review voiceover</strong>Listen before any scene images are created.</span></label>
              </div>
            </section>

            {!snapshot && (
              <div className="creative-footer-action">
                <button type="button" className="creative-button creative-button-primary" disabled={!creative || pending === 'create'} onClick={createProject}>{pending === 'create' ? 'Creating project…' : 'Choose folder & create project'}</button>
                <div className="creative-hint" style={{ textAlign: 'center' }}>Vidmyo creates a new named subfolder. Your chosen folder is never overwritten.</div>
              </div>
            )}
          </div>

          <aside className="creative-column creative-column-preview">
            <section className={`creative-preview ${brief.aspect === '9:16' ? 'portrait' : ''}`}>
              {snapshot?.previewUrl ? <video controls preload="metadata" src={snapshot.previewUrl} /> : (
                <div className="creative-preview-placeholder"><div><div className="creative-preview-glyph" aria-hidden="true">▶</div><strong>{snapshot ? 'Your preview will appear here' : `${brief.aspect === '9:16' ? 'Portrait' : 'Landscape'} preview`}</strong><span>{snapshot ? 'Vidmyo keeps this panel tied to the open project while production runs.' : isStory ? (brief.characterAnimation === 'animated' ? 'Beta character animation on still backgrounds.' : 'Illustrated scenes with gentle camera movement, timed to narration.') : `${style.name} in ${brief.aspect} at ${brief.durationSec || 0} seconds.`}</span></div></div>
              )}
            </section>

            {snapshot ? (
              <ProgressCard snapshot={snapshot} pending={pending} logs={logs} onStart={startProduction} onApprove={() => startProduction(true)} onImportFlowImages={importFlowImages} onCancel={cancelProduction} onReveal={revealProject} error={error} />
            ) : (
              <section className="creative-card">
                <SectionHeading number="" title="Recent work" copy="Projects are stored on disk and can be reopened after restarting Vidmyo." action={<button type="button" className="creative-button creative-button-small creative-button-quiet" disabled={!creative} onClick={refreshRecents}>Refresh</button>} />
                {recents.length > 0 ? <div className="creative-recent-list">{recents.slice(0, 8).map(item => <button key={item.dir} type="button" className="creative-list-item" onClick={() => openProject(item.dir)}><span className="creative-list-main"><span className="creative-list-title">{item.title || 'Untitled project'}</span><span className="creative-list-meta">{shortDate(item.updatedAt)} · {item.style || item.kind}</span></span><span aria-hidden="true">›</span></button>)}</div> : <div className="creative-empty">Your {isStory ? 'Stickman' : 'Animation'} projects will appear here after you create or open one.</div>}
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
