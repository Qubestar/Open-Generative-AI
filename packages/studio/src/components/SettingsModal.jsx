import { useState, useEffect, useCallback } from 'react';
import { PROVIDERS, PROVIDER_CATEGORIES } from '../../../core/src/providers.js';

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

export default function SettingsModal({ onClose, onCloudKeyChange }) {
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
      <div className="bg-[#0a0a0a] border border-white/10 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
        <div className="p-6 pb-4 border-b border-white/5">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-white font-bold text-lg">Settings</h2>
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
                        <div className="flex items-center gap-2 px-3.5 pb-3">
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
                          {p.docsUrl && (
                            <a href={p.docsUrl} target="_blank" rel="noreferrer"
                               className="text-[11px] text-white/40 hover:text-white/70 whitespace-nowrap">get a key ↗</a>
                          )}
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
