import { useState, useEffect, useCallback } from 'react';
import { PROVIDERS, PROVIDER_CATEGORIES } from '../../../core/src/providers.js';
import { IMAGE_SOURCES } from '../../../core/src/story.js';
import { APPEARANCES } from '../appearance.mjs';
import './SettingsModal.css';

// Settings — provider API keys over the canonical @vidmyo/core catalog.
// Desktop app: keys are encrypted into the macOS keychain via
// window.secureKeys (electron/lib/secrets.js) — they never sit in plain
// localStorage. Plain browser tab: localStorage fallback so the hosted
// build still works. The muapi key is additionally mirrored to the legacy
// 'vidmyo_cloud_key' slot the shell's balance polling and older studios use.

const LEGACY_CLOUD_KEY = 'vidmyo_cloud_key';
const lsKey = (id) => `vidmyo_key_${id}`;

// Only providers a key can be entered for (integrations connect via their own CLIs).
const KEYED_CATEGORIES = ['aggregator', 'direct', 'budget'];

// How "Launch" opens a detected agent from the Agents tab.
function AgentLaunchSection() {
  const hasAgents = typeof window !== 'undefined' && !!window.agents?.isElectron && !!window.agents.getLaunchConfig;
  const [mode, setMode] = useState('desktop');
  useEffect(() => {
    if (hasAgents) window.agents.getLaunchConfig().then((r) => r?.ok && setMode(r.launchMode));
  }, [hasAgents]);
  if (!hasAgents) return null;
  return (
    <div>
      <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Agents</div>
      <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg px-3.5 py-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-white">Open agents as</div>
          <div className="text-[11px] text-white/40">Falls back to Terminal when an agent has no desktop app installed.</div>
        </div>
        <select
          value={mode}
          onChange={async (e) => {
            const r = await window.agents.setLaunchConfig({ launchMode: e.target.value });
            if (r?.ok) setMode(r.launchMode);
          }}
          className="bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-[12px] text-white outline-none shrink-0"
        >
          <option value="desktop">Desktop app</option>
          <option value="terminal">Terminal</option>
        </select>
      </div>
    </div>
  );
}

// Where the Story tab's scene-image ⚡ generates from. Default (Google Flow) is
// free but manual, so it has no model choice — you Attach instead.
function StoryImageSection({ savedKeys }) {
  const hasStory = typeof window !== 'undefined' && !!window.story?.isElectron && !!window.story.getImageConfig;
  const [cfg, setCfg] = useState(null);   // {imageSource, imageModel}
  useEffect(() => {
    if (hasStory) window.story.getImageConfig().then((r) => r?.ok && setCfg(r));
  }, [hasStory]);
  if (!hasStory || !cfg) return null;

  const source = IMAGE_SOURCES.find((s) => s.id === cfg.imageSource) || IMAGE_SOURCES[0];
  const save = async (next) => {
    const r = await window.story.setImageConfig(next);
    if (r?.ok) setCfg(r);
  };
  // A paid source with no key can't generate — say so here rather than at click time.
  const missingKey = !source.manual && !savedKeys[source.provider];

  return (
    <div>
      <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Story</div>
      <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-white">Scene image source</div>
            <div className="text-[11px] text-white/40">{source.note}</div>
          </div>
          <select
            value={source.id}
            onChange={(e) => save({ imageSource: e.target.value })}
            className="bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-[12px] text-white outline-none shrink-0"
          >
            {IMAGE_SOURCES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {source.models.length > 0 && (
          <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-white/[0.05]">
            <div className="text-[12px] text-white/60">Model</div>
            <select
              value={cfg.imageModel || ''}
              onChange={(e) => save({ imageSource: source.id, imageModel: e.target.value })}
              className="bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-[12px] text-white outline-none shrink-0"
            >
              {source.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        )}

        {missingKey && (
          <div className="text-[11px] text-amber-400/80 mt-2">
            No {source.name} key saved yet — add one below, or scene images will fail to generate.
          </div>
        )}
      </div>
    </div>
  );
}

// Read-only "Engines & models" section (V2.6 Phase 5, Step 6). Surfaces what
// the desktop actually has: the FFmpeg capability report, the pinned
// HyperFrames engine, and managed model packages. Nothing here installs or
// downloads — a `manifest-pending` package keeps its install button disabled
// and states the reason.
function EnginesModelsSection() {
  const hasEngines = typeof window !== 'undefined' && !!window.engines?.isElectron && !!window.engines.modelPackagesStatus;
  const hasPromo = typeof window !== 'undefined' && !!window.promo?.ffmpegCapabilities;
  const [ffmpeg, setFfmpeg] = useState(null);
  const [hf, setHf] = useState(null);
  const [packages, setPackages] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (hasPromo) {
          const r = await window.promo.ffmpegCapabilities();
          if (mounted) setFfmpeg(r?.report || r || null);
        }
        if (hasEngines) {
          const [hfRes, pkgRes] = await Promise.all([
            window.engines.hyperframesStatus ? window.engines.hyperframesStatus() : Promise.resolve(null),
            window.engines.modelPackagesStatus(),
          ]);
          if (!mounted) return;
          if (hfRes) setHf(hfRes);
          if (pkgRes?.ok) setPackages(pkgRes.packages || []);
          else if (pkgRes?.error) setErr(pkgRes.error);
        }
      } catch (e) {
        if (mounted) setErr(e.message);
      }
    })();
    return () => { mounted = false; };
  }, [hasEngines, hasPromo]);

  const ffmpegLine = ffmpeg
    ? (ffmpeg.missing
        ? 'FFmpeg niedostępny'
        : `${ffmpeg.version || 'nieznana wersja'} · ${ffmpeg.licenseClass || '?'} · źródło: ${ffmpeg.source || '?'}`)
    : (hasPromo ? 'Sprawdzanie…' : 'Dostępne w aplikacji desktopowej (Electron)');

  return (
    <section aria-label="Engines and models" data-testid="engines-models">
      <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Engines &amp; models</div>
      <div className="bg-white/[0.03] border border-white/[0.05] rounded-lg px-3.5 py-3 space-y-3">
        <div>
          <div className="text-[12px] font-semibold text-white">FFmpeg capabilities</div>
          <div className="text-[11px] text-white/50 font-mono" data-testid="engines-ffmpeg">{ffmpegLine}</div>
          {ffmpeg && !ffmpeg.missing && ffmpeg.filters && (
            <div className="text-[10px] text-white/40 mt-1">
              Napisy: drawtext:{ffmpeg.filters.drawtext ? ' tak' : ' nie'} · libass:{ffmpeg.libass ? ' tak' : ' nie'}
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.05] pt-3">
          <div className="text-[12px] font-semibold text-white">HyperFrames engine</div>
          <div className="text-[11px] text-white/50" data-testid="engines-hyperframes">
            {hf
              ? (hf.installed
                  ? `Przypięty ${hf.pinned} (${hf.license}) — zainstalowany${hf.matchesPin ? '' : ' (niezgodna wersja)'}`
                  : `Przypięty ${hf.pinned} —${' '}${hf.reason || 'nie zainstalowany'}`)
              : 'Status dostępny w aplikacji desktopowej'}
          </div>
        </div>

        <div className="border-t border-white/[0.05] pt-3">
          <div className="text-[12px] font-semibold text-white">Model packages</div>
          {packages && packages.length > 0 ? (
            <div className="space-y-1.5 mt-1.5">
              {packages.map((p) => (
                <div key={p.name} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] font-mono text-white/80 truncate">{p.name}</div>
                    <div className="text-[10px] text-white/40">
                      {p.status}{p.license ? ` · ${p.license}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled
                    title={p.installable ? 'Instalacja nie jest włączona w tym etapie' : 'manifest-pending: brak zweryfikowanego URL/SHA-256/licencji'}
                    className="px-2.5 py-1 rounded-md bg-white/5 text-white/40 text-[10px] font-semibold border border-white/5 cursor-not-allowed"
                  >
                    Zainstaluj
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-white/50 mt-1">Status dostępny w aplikacji desktopowej</div>
          )}
          {packages && packages.length === 0 && (
            <div className="text-[10px] text-white/40 mt-1">Brak wpisów w katalogu paczek.</div>
          )}
        </div>

        {err && <div className="text-[11px] text-amber-400/80 border-t border-white/[0.05] pt-2">Błąd: {err}</div>}
      </div>
    </section>
  );
}

export default function SettingsModal({ onClose, onCloudKeyChange, appearance = 'dark', onAppearanceChange }) {
  const hasKeychain = typeof window !== 'undefined' && !!window.secureKeys?.isElectron;
  const [keys, setKeys] = useState({});        // providerId -> saved key (plaintext, in-memory only)
  const [drafts, setDrafts] = useState({});    // providerId -> input value
  const [openId, setOpenId] = useState(null);  // which provider row is expanded
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      if (hasKeychain && (await window.secureKeys.isAvailable())) {
        const res = await window.secureKeys.getAll();
        if (res?.ok) { setKeys(res.keys || {}); return; }
      }
      const fromLs = {};
      for (const p of PROVIDERS) {
        const v = localStorage.getItem(lsKey(p.id));
        if (v) fromLs[p.id] = v;
      }
      const legacy = localStorage.getItem(LEGACY_CLOUD_KEY);
      if (legacy && !fromLs.muapi) fromLs.muapi = legacy;
      setKeys(fromLs);
    })();
  }, [hasKeychain]);

  const saveKey = useCallback(async (id, value) => {
    const key = (value || '').trim();
    if (hasKeychain) {
      const res = await window.secureKeys.set(id, key);
      if (!res?.ok) { setStatus(`Could not save ${id}: ${res?.error || 'keychain error'}`); return; }
    } else if (key) {
      localStorage.setItem(lsKey(id), key);
    } else {
      localStorage.removeItem(lsKey(id));
    }
    if (id === 'muapi') {
      // Legacy mirror for the shell's balance polling + older studios.
      if (key) localStorage.setItem(LEGACY_CLOUD_KEY, key);
      else localStorage.removeItem(LEGACY_CLOUD_KEY);
      onCloudKeyChange?.(key || null);
    }
    setKeys((k) => {
      const next = { ...k };
      if (key) next[id] = key; else delete next[id];
      return next;
    });
    setDrafts((d) => ({ ...d, [id]: '' }));
    setOpenId(null);
    setStatus(key ? `${id} key saved${hasKeychain ? ' to the keychain' : ''}` : `${id} key removed`);
  }, [hasKeychain, onCloudKeyChange]);

  const grouped = PROVIDER_CATEGORIES
    .filter((c) => KEYED_CATEGORIES.includes(c.id))
    .map((c) => ({ ...c, providers: PROVIDERS.filter((p) => p.category === c.id) }))
    .filter((c) => c.providers.length > 0);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in-up"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Settings" style={{ background: 'var(--vm-panel)', color: 'var(--vm-text)', borderColor: 'var(--vm-line)' }} className="vidmyo-settings border rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
        <div className="p-6 pb-4 border-b border-white/5">
          <div className="flex items-start justify-between">
            <div>
              <h2 style={{ color: 'var(--vm-text)' }} className="font-bold text-lg">Settings</h2>
              <p className="text-white/40 text-[12px] mt-1">
                Bring-your-own-key providers.{' '}
                {hasKeychain
                  ? 'Keys are encrypted into the macOS keychain — never stored in plain text.'
                  : 'Browser mode: keys are stored in this browser only.'}
              </p>
            </div>
            <button onClick={onClose}
                    className="px-3 py-1.5 rounded-md bg-white/5 text-white/80 hover:bg-white/10 text-xs font-semibold border border-white/5">
              Close
            </button>
          </div>
          {status && <div className="text-[11px] text-emerald-400 mt-2">{status}</div>}
        </div>

        <div className="flex-1 overflow-y-auto p-6 pt-4 space-y-5">
          {onAppearanceChange && (
            <section aria-label="Appearance settings">
              <label htmlFor="vidmyo-appearance" style={{ display: 'block', fontSize: 13, fontWeight: 650, marginBottom: 8 }}>Appearance</label>
              <select id="vidmyo-appearance" value={appearance} onChange={onAppearanceChange}
                style={{ width: '100%', padding: 10, borderRadius: 8, background: 'var(--vm-input)', color: 'var(--vm-text)', border: '1px solid var(--vm-line)' }}>
                {APPEARANCES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <p style={{ color: 'var(--vm-muted)', fontSize: 12, marginTop: 8 }}>Changes apply immediately and are remembered on this device.</p>
            </section>
          )}
          <AgentLaunchSection />
          <StoryImageSection savedKeys={keys} />
          <EnginesModelsSection />
          {grouped.map((cat) => (
            <div key={cat.id}>
              <div className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">{cat.label}</div>
              <div className="space-y-1.5">
                {cat.providers.map((p) => {
                  const saved = keys[p.id];
                  const open = openId === p.id;
                  return (
                    <div key={p.id} className="bg-white/[0.03] border border-white/[0.05] rounded-lg">
                      <div className="flex items-center justify-between px-3.5 py-2.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color || '#666' }} />
                          <span className="text-[13px] font-semibold text-white truncate">{p.name}</span>
                          {saved && <span className="text-[10px] font-bold text-emerald-400 shrink-0">connected</span>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {saved && (
                            <span className="hidden sm:inline text-[11px] font-mono text-white/40">
                              {saved.slice(0, 6)}••••••
                            </span>
                          )}
                          <button
                            onClick={() => { setOpenId(open ? null : p.id); setDrafts((d) => ({ ...d, [p.id]: '' })); }}
                            className="px-2.5 py-1 rounded-md bg-white/5 text-white/80 hover:bg-white/10 text-[11px] font-semibold border border-white/5">
                            {saved ? 'Change' : 'Add key'}
                          </button>
                          {saved && (
                            <button onClick={() => saveKey(p.id, '')}
                                    className="px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 text-[11px] font-semibold">
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                      {open && (
                        <div className="px-3.5 pb-3">
                          {p.description && (
                            <div className="text-[11px] text-white/40 mb-1.5 leading-snug">{p.description}</div>
                          )}
                          <div className="flex items-center gap-2">
                            <input
                              type="password" autoFocus
                              value={drafts[p.id] || ''}
                              onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') saveKey(p.id, drafts[p.id]); }}
                              placeholder={`${p.name} API key`}
                              className="flex-1 bg-black/40 border border-white/10 focus:border-white/25 rounded-md px-3 py-1.5 text-[12px] font-mono text-white outline-none"
                            />
                            <button onClick={() => saveKey(p.id, drafts[p.id])}
                                    className="px-3 py-1.5 rounded-md bg-white text-black text-[11px] font-bold">Save</button>
                            {(p.affiliateUrl || p.docsUrl) && (
                              <a href={p.affiliateUrl || p.docsUrl} target="_blank" rel="noreferrer"
                                 title={p.affiliateUrl ? 'Affiliate link — supports Vidmyo at no extra cost to you' : undefined}
                                 className="text-[11px] text-white/40 hover:text-white/70 whitespace-nowrap">
                                get a key ↗{p.affiliateUrl ? ' · affiliate' : ''}
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
