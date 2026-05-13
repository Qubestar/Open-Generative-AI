// Provider registry for Vidmyo
// Maps external provider APIs so users can bring their own keys.

export const PROVIDERS = [
  {
    id: 'muapi',
    name: 'Muapi',
    type: 'aggregator',
    baseUrl: 'https://api.muapi.ai',
    authHeader: 'x-api-key',
    authPrefix: '',
    authInQuery: false,
    color: '#7c3aed',
    icon: 'muapi',
    description: 'Unified access to 200+ models. One key, every model.',
    docsUrl: 'https://muapi.ai',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'direct',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#10a37f',
    icon: 'openai',
    description: 'DALL·E 3, GPT-4o, Sora (when available).',
    docsUrl: 'https://platform.openai.com/api-keys',
    endpoints: {
      image: '/images/generations',
      chat: '/chat/completions',
    }
  },
  {
    id: 'anthropic',
    name: 'Claude / Anthropic',
    type: 'direct',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    authInQuery: false,
    color: '#d97757',
    icon: 'anthropic',
    description: 'Claude 3.5 Sonnet, Claude Opus. Text + vision capabilities.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    endpoints: {
      chat: '/messages',
    }
  },
  {
    id: 'xai',
    name: 'Grok / xAI',
    type: 'direct',
    baseUrl: 'https://api.x.ai/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#f3f4f6',
    icon: 'xai',
    description: 'Grok 2, Grok Imagine image generation.',
    docsUrl: 'https://console.x.ai',
    endpoints: {
      image: '/images/generations',
      chat: '/chat/completions',
    }
  },
  {
    id: 'google',
    name: 'Gemini / Google',
    type: 'direct',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeader: 'key',
    authPrefix: '',
    authInQuery: true,
    color: '#4285f4',
    icon: 'google',
    description: 'Gemini 2.5 Pro, Imagen 3, video understanding.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    endpoints: {
      image: '/models/imagen-3.0-generate-002:predict',
      chat: '/models/gemini-2.5-pro-preview-03-25:generateContent',
    }
  },
  {
    id: 'heygen',
    name: 'HeyGen',
    type: 'direct',
    baseUrl: 'https://api.heygen.com/v2',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#635bff',
    icon: 'heygen',
    description: 'AI avatars, talking photos, video translation, streaming avatars.',
    docsUrl: 'https://app.heygen.com/settings?nav=API',
    endpoints: {
      video: '/video/generate',
      avatar: '/avatars',
      template: '/templates',
    }
  },
];

export const DEFAULT_PROVIDER = 'muapi';

// ── Provider helpers ──────────────────────────────────────

export function getProviderById(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

export function getAllProviders() {
  return PROVIDERS;
}

// Infer the native provider for a given model entry.
export function inferProviderForModel(model) {
  if (!model) return 'muapi';
  const id = model.id || '';
  const endpoint = model.endpoint || '';
  const family = model.family || '';

  if (family) return family;
  if (id.startsWith('openai-') || id.includes('gpt4o')) return 'openai';
  if (id.startsWith('google-') || id.includes('imagen')) return 'google';
  if (id.startsWith('grok-')) return 'xai';
  if (id.startsWith('flux-') && id.includes('kontext')) return 'blackforest'; // flux-kontext
  if (id.startsWith('flux-')) return 'blackforest';
  if (id.startsWith('hidream-')) return 'hidream';
  if (id.startsWith('wan2')) return 'wan2';
  if (id.startsWith('kling-')) return 'kling';
  if (id.startsWith('luma-')) return 'luma';
  if (id.startsWith('veo-') || id.includes('veo')) return 'google';
  if (id.startsWith('seedream-')) return 'seedream';
  if (id.startsWith('recraft-')) return 'recraft';
  if (id.startsWith('minimax-')) return 'minimax';
  if (id.startsWith('mochi-')) return 'mochi';

  return 'muapi';
}

// Return the user's saved API key for a provider (localStorage key pattern).
export function getProviderStorageKey(providerId) {
  return `vidmyo_key_${providerId}`;
}

export function getSavedProviderKey(providerId) {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(getProviderStorageKey(providerId)) || '';
}

export function setSavedProviderKey(providerId, key) {
  if (typeof window === 'undefined') return;
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

// For direct providers, build the full request URL.
export function buildProviderUrl(provider, endpointPath) {
  const base = provider.baseUrl.replace(/\/$/, '');
  const path = (endpointPath || '').replace(/^\//, '');
  return `${base}/${path}`;
}

// Build headers object for a provider + optional user key.
export function buildProviderHeaders(provider, userKey) {
  const key = userKey || getSavedProviderKey(provider.id);
  if (!key) return { 'Content-Type': 'application/json' };
  const value = provider.authPrefix ? `${provider.authPrefix}${key}` : key;
  return {
    'Content-Type': 'application/json',
    [provider.authHeader]: value,
  };
}

// Append auth key to query string if the provider requires it.
export function appendProviderAuthToUrl(provider, url, userKey) {
  if (!provider.authInQuery) return url;
  const key = userKey || getSavedProviderKey(provider.id);
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${provider.authHeader}=${encodeURIComponent(key)}`;
}
