// Provider registry — renderer surface.
//
// The catalog and all pure helpers live in @vidmyo/core
// (packages/core/src/providers.js) — the single source of truth shared with
// the CLI and MCP server. Do NOT add provider entries here. This module only
// adds what is browser/desktop-specific: key storage (OS keychain in the
// desktop app, localStorage in the browser) and UI connection state.

export {
  PROVIDER_CATEGORIES,
  PROVIDERS,
  DEFAULT_PROVIDER,
  getProviderById,
  getAllProviders,
  getProvidersByCategory,
  getProvidersForStudio,
  inferProviderForModel,
  buildProviderUrl,
  buildProviderHeaders,
  appendProviderAuthToUrl,
} from '../../packages/core/src/providers.js';

import { DEFAULT_PROVIDER } from '../../packages/core/src/providers.js';

// ── Key storage (surface-specific) ───────────────────────────────────────────
//
// Desktop app: keys live in the OS keychain (Electron safeStorage via
// window.secureKeys) behind an in-memory cache so existing synchronous call
// sites keep working. Browser build: localStorage fallback.
// initSecureKeys() runs once at startup (src/main.js); it loads the cache and
// migrates any legacy localStorage keys into the keychain, then deletes them.

export function getProviderStorageKey(providerId) {
  return `vidmyo_key_${providerId}`;
}

let secureKeyCache = null; // null = keychain not initialized → localStorage

export async function initSecureKeys() {
  if (typeof window === 'undefined' || !window.secureKeys?.isElectron) return;
  try {
    if (!(await window.secureKeys.isAvailable())) return;
    const res = await window.secureKeys.getAll();
    if (!res?.ok) return;
    secureKeyCache = res.keys || {};

    // One-time migration: move legacy localStorage keys into the keychain.
    const legacy = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('vidmyo_key_')) legacy.push(k);
    }
    if (localStorage.getItem('muapi_key')) legacy.push('muapi_key');
    for (const k of legacy) {
      const id = k === 'muapi_key' ? 'muapi' : k.slice('vidmyo_key_'.length);
      const val = localStorage.getItem(k);
      if (val && !secureKeyCache[id]) {
        const set = await window.secureKeys.set(id, val);
        if (!set?.ok) continue; // keep the localStorage copy if the write failed
        secureKeyCache[id] = val;
      }
      localStorage.removeItem(k);
    }
  } catch {
    secureKeyCache = null; // fall back to localStorage
  }
}

export function getSavedProviderKey(providerId) {
  if (typeof window === 'undefined') return '';
  if (secureKeyCache) return secureKeyCache[providerId] || '';
  return localStorage.getItem(getProviderStorageKey(providerId)) || '';
}

export function setSavedProviderKey(providerId, key) {
  if (typeof window === 'undefined') return;
  if (secureKeyCache) {
    if (key) secureKeyCache[providerId] = key;
    else delete secureKeyCache[providerId];
    window.secureKeys.set(providerId, key || '');
    return;
  }
  if (key) localStorage.setItem(getProviderStorageKey(providerId), key);
  else localStorage.removeItem(getProviderStorageKey(providerId));
}

export function getActiveProviderId() {
  if (typeof window === 'undefined') return DEFAULT_PROVIDER;
  return localStorage.getItem('vidmyo_active_provider') || DEFAULT_PROVIDER;
}

export function setActiveProviderId(id) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('vidmyo_active_provider', id);
}

// For OAuth/CLI integrations, track connection state separately.
export function getIntegrationConnected(providerId) {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(`vidmyo_connected_${providerId}`) === 'true';
}

export function setIntegrationConnected(providerId, connected) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`vidmyo_connected_${providerId}`, connected ? 'true' : 'false');
}
