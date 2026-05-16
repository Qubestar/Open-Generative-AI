// Provider registry for Vidmyo
// Maps external provider APIs so users can bring their own keys.
// Categories: aggregator, direct, integration (OAuth/CLI), budget (cheap APIs).

export const PROVIDER_CATEGORIES = [
  { id: 'aggregator', label: 'Unified' },
  { id: 'direct', label: 'Direct API' },
  { id: 'budget', label: 'Budget / Value' },
  { id: 'integration', label: 'Agent Integrations' },
];

export const PROVIDERS = [
  // ── Aggregator ───────────────────────────────────────────────────────────
  {
    id: 'muapi',
    name: 'Muapi',
    category: 'aggregator',
    type: 'aggregator',
    baseUrl: 'https://api.muapi.ai',
    authHeader: 'x-api-key',
    authPrefix: '',
    authInQuery: false,
    color: '#7c3aed',
    icon: 'muapi',
    description: 'Unified access to 200+ models. One key, every model.',
    docsUrl: 'https://muapi.ai',
    studios: ['image', 'video', 'lipsync', 'cinema', 'marketing'],
  },

  // ── Direct APIs (Premium) ────────────────────────────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#10a37f',
    icon: 'openai',
    description: 'DALL·E 3, GPT-4o, GPT-4.5. Image generation + chat.',
    docsUrl: 'https://platform.openai.com/api-keys',
    endpoints: {
      image: '/images/generations',
      chat: '/chat/completions',
      edit: '/images/edits',
    },
    studios: ['image'],
  },
  {
    id: 'anthropic',
    name: 'Claude / Anthropic',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    authInQuery: false,
    color: '#d97757',
    icon: 'anthropic',
    description: 'Claude 3.5 Sonnet, Claude Opus. Text + vision.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    endpoints: {
      chat: '/messages',
    },
    studios: [],
  },
  {
    id: 'xai',
    name: 'Grok / xAI',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.x.ai/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#1a1a1a',
    icon: 'xai',
    description: 'Grok 2, Grok Imagine image generation.',
    docsUrl: 'https://console.x.ai',
    endpoints: {
      image: '/images/generations',
      chat: '/chat/completions',
    },
    studios: ['image'],
  },
  {
    id: 'google',
    name: 'Gemini / Google',
    category: 'direct',
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
    },
    studios: ['image'],
  },
  {
    id: 'heygen',
    name: 'HeyGen',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.heygen.com/v2',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#635bff',
    icon: 'heygen',
    description: 'AI avatars, talking photos, video translation, streaming.',
    docsUrl: 'https://app.heygen.com/settings?nav=API',
    endpoints: {
      video: '/video/generate',
      avatar: '/avatars',
      lipsync: '/video/generate',
      template: '/templates',
    },
    studios: ['lipsync'],
  },
  {
    id: 'runway',
    name: 'Runway ML',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.runwayml.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#000000',
    icon: 'runway',
    description: 'Gen-3 Alpha image-to-video, text-to-video, video-to-video.',
    docsUrl: 'https://dev.runwayml.com/',
    endpoints: {
      video: '/generate',
      image_to_video: '/generate',
    },
    studios: ['video'],
  },
  {
    id: 'luma',
    name: 'Luma Dream Machine',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#6366f1',
    icon: 'luma',
    description: 'Dream Machine image-to-video and text-to-video.',
    docsUrl: 'https://lumalabs.ai/dream-machine/api',
    endpoints: {
      video: '/generations',
      image_to_video: '/generations',
    },
    studios: ['video'],
  },
  {
    id: 'pika',
    name: 'Pika Labs',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.pika.art/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#ec4899',
    icon: 'pika',
    description: 'Pika 2.0 text-to-video, image-to-video, video effects.',
    docsUrl: 'https://pika.art/docs',
    endpoints: {
      video: '/generations',
      image_to_video: '/generations',
    },
    studios: ['video'],
  },
  {
    id: 'kling',
    name: 'Kling AI',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.klingai.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#f97316',
    icon: 'kling',
    description: 'Kling 2.0 video generation, lip sync, virtual try-on.',
    docsUrl: 'https://klingai.com/',
    endpoints: {
      video: '/generations',
      image_to_video: '/generations',
      lipsync: '/lip_sync',
    },
    studios: ['video', 'lipsync'],
  },
  {
    id: 'recraft',
    name: 'Recraft',
    category: 'direct',
    type: 'direct',
    baseUrl: 'https://api.recraft.ai/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#10b981',
    icon: 'recraft',
    description: 'Recraft vector art, illustrations, and image generation.',
    docsUrl: 'https://www.recraft.ai/docs',
    endpoints: {
      image: '/images/generations',
      vector: '/images/vectorize',
    },
    studios: ['image'],
  },

  // ── Budget / Value ─────────────────────────────────────────────────────────
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.deepseek.com/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#4f6ef7',
    icon: 'deepseek',
    description: 'DeepSeek-V3 chat, DeepSeek-Coder. Extremely cheap.',
    docsUrl: 'https://platform.deepseek.com/',
    endpoints: {
      chat: '/chat/completions',
    },
    studios: [],
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.moonshot.cn/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#f59e0b',
    icon: 'moonshot',
    description: 'Moonshot-v1 models. Strong Chinese + multilingual.',
    docsUrl: 'https://platform.moonshot.cn/',
    endpoints: {
      chat: '/chat/completions',
    },
    studios: [],
  },
  {
    id: 'qwen',
    name: 'Qwen / Alibaba',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#ff6a00',
    icon: 'qwen',
    description: 'Qwen-Max, Qwen-VL, Qwen-Audio. Multimodal Chinese models.',
    docsUrl: 'https://dashscope.aliyun.com/',
    endpoints: {
      chat: '/chat/completions',
    },
    studios: [],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#06b6d4',
    icon: 'siliconflow',
    description: 'SiliconFlow inference platform. Cheap access to open models.',
    docsUrl: 'https://siliconflow.cn/',
    endpoints: {
      chat: '/chat/completions',
      image: '/images/generations',
    },
    studios: ['image'],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#ef4444',
    icon: 'fireworks',
    description: 'Fast inference for open-source and fine-tuned models.',
    docsUrl: 'https://fireworks.ai/',
    endpoints: {
      chat: '/chat/completions',
    },
    studios: [],
  },
  {
    id: 'together',
    name: 'Together AI',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.together.xyz/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#8b5cf6',
    icon: 'together',
    description: 'Inference platform for open-source LLMs and diffusion.',
    docsUrl: 'https://api.together.xyz/',
    endpoints: {
      chat: '/chat/completions',
      image: '/images/generations',
    },
    studios: ['image'],
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'budget',
    type: 'direct',
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    authInQuery: false,
    color: '#f97316',
    icon: 'groq',
    description: 'Ultra-fast inference. Llama, Mixtral, Gemma.',
    docsUrl: 'https://console.groq.com/keys',
    endpoints: {
      chat: '/chat/completions',
    },
    studios: [],
  },

  // ── Agent Integrations (OAuth / CLI) ──────────────────────────────────────
  {
    id: 'claude_code',
    name: 'Claude Code',
    category: 'integration',
    type: 'oauth',
    color: '#d97757',
    icon: 'anthropic',
    description: "Anthropic's Claude Code CLI agent. Requires local Node.js + npx.",
    docsUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code',
    oauthUrl: 'https://console.anthropic.com/',
    cliCommand: 'npx @anthropic-ai/claude-code',
    scopes: ['code', 'workspace'],
    connected: false,
    studios: [],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    category: 'integration',
    type: 'oauth',
    color: '#10a37f',
    icon: 'openai',
    description: 'OpenAI Codex CLI coding agent. Requires local Node.js + npx.',
    docsUrl: 'https://github.com/openai/codex',
    oauthUrl: 'https://platform.openai.com/api-keys',
    cliCommand: 'npx @openai/codex',
    scopes: ['code', 'workspace'],
    connected: false,
    studios: [],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    category: 'integration',
    type: 'oauth',
    color: '#7c3aed',
    icon: 'hermes',
    description: 'Local Hermes multi-agent system. Requires local Python/Node.',
    docsUrl: 'https://github.com/outsourc-e/hermes-agent',
    oauthUrl: 'https://github.com/outsourc-e/hermes-agent',
    cliCommand: 'npx @outsourc-e/hermes-agent',
    scopes: ['code', 'workspace', 'files'],
    connected: false,
    studios: [],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    category: 'integration',
    type: 'oauth',
    color: '#06b6d4',
    icon: 'opencode',
    description: 'OpenCode CLI coding agent. Free and open-source.',
    docsUrl: 'https://github.com/opencode-ai/opencode',
    oauthUrl: 'https://github.com/opencode-ai/opencode',
    cliCommand: 'npx @opencode-ai/opencode',
    scopes: ['code', 'workspace'],
    connected: false,
    studios: [],
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

export function getProvidersByCategory(categoryId) {
  return PROVIDERS.filter(p => p.category === categoryId);
}

export function getProvidersForStudio(studioType) {
  return PROVIDERS.filter(p =>
    p.studios?.includes(studioType) || p.studios?.includes('*')
  );
}

// Infer the native provider for a given model entry.
export function inferProviderForModel(model) {
  if (!model) return 'muapi';
  const id = model.id || '';
  const endpoint = model.endpoint || '';
  const family = model.family || '';

  if (family) return family;
  if (id.startsWith('openai-') || id.includes('gpt4o') || id.includes('dall')) return 'openai';
  if (id.startsWith('google-') || id.includes('imagen') || id.includes('veo')) return 'google';
  if (id.startsWith('grok-')) return 'xai';
  if (id.startsWith('flux-') && id.includes('kontext')) return 'blackforest';
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
  if (id.startsWith('runway-') || id.startsWith('gen-')) return 'runway';
  if (id.startsWith('pika-')) return 'pika';

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

// For OAuth/CLI integrations, track connection state separately.
export function getIntegrationConnected(providerId) {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(`vidmyo_connected_${providerId}`) === 'true';
}

export function setIntegrationConnected(providerId, connected) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(`vidmyo_connected_${providerId}`, connected ? 'true' : 'false');
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
