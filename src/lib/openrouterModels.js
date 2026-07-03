// OpenRouter media-generation model catalog for Vidmyo.
//
// OpenRouter exposes video + image generation models via its own async API
// (POST /api/v1/videos → poll). These entries are shaped to match the studio's
// t2vModels / i2vModels so the existing model picker, aspect-ratio, duration and
// resolution helpers work unchanged. `provider: 'openrouter'` + `orModel` tell
// MuapiClient to route generation through openrouterClient instead of Muapi.
//
// Model ids are prefixed `or-` to avoid colliding with the Muapi catalog.

const COMMON_AR = ['16:9', '9:16', '1:1', '4:3', '3:4'];

function t2v(id, name, orModel, opts = {}) {
  return {
    id: `or-${id}`,
    name,
    provider: 'openrouter',
    orModel,
    inputs: {
      prompt: { type: 'string', title: 'Prompt', name: 'prompt', description: 'The prompt to generate the video' },
      aspect_ratio: {
        enum: opts.aspectRatios || COMMON_AR,
        title: 'Aspect Ratio', name: 'aspect_ratio', type: 'string',
        description: 'Aspect ratio of the output video.', default: '16:9',
      },
      ...(opts.durations ? {
        duration: { enum: opts.durations, title: 'Duration', name: 'duration', type: 'int', description: 'Duration in seconds', default: opts.durations[0] },
      } : {}),
    },
  };
}

function i2v(id, name, orModel, opts = {}) {
  return {
    id: `or-${id}-i2v`,
    name,
    provider: 'openrouter',
    orModel,
    imageField: 'image_url', // studio: this model accepts a start-frame image
    inputs: {
      prompt: { type: 'string', title: 'Prompt', name: 'prompt', description: 'Optional prompt to guide the motion' },
      aspect_ratio: {
        enum: opts.aspectRatios || COMMON_AR,
        title: 'Aspect Ratio', name: 'aspect_ratio', type: 'string',
        description: 'Aspect ratio of the output video.', default: '16:9',
      },
    },
  };
}

// Curated set of OpenRouter video models (output_modalities=video).
export const openrouterVideoModels = [
  t2v('veo-3.1-fast', 'Google Veo 3.1 Fast', 'google/veo-3.1-fast'),
  t2v('veo-3.1-lite', 'Google Veo 3.1 Lite', 'google/veo-3.1-lite'),
  t2v('kling-v3-pro', 'Kling v3.0 Pro', 'kwaivgi/kling-v3.0-pro', { durations: [5, 10] }),
  t2v('kling-v3-std', 'Kling v3.0 Standard', 'kwaivgi/kling-v3.0-std', { durations: [5, 10] }),
  t2v('grok-imagine', 'xAI Grok Imagine Video', 'x-ai/grok-imagine-video', { aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] }),
  t2v('hailuo-2.3', 'MiniMax Hailuo 2.3', 'minimax/hailuo-2.3'),
  t2v('seedance-2.0', 'Seedance 2.0', 'bytedance/seedance-2.0', { durations: [5, 10] }),
  t2v('seedance-2.0-fast', 'Seedance 2.0 Fast', 'bytedance/seedance-2.0-fast', { durations: [5, 10] }),
  t2v('wan-2.7', 'Alibaba Wan 2.7', 'alibaba/wan-2.7'),
];

// Image-to-video variants (same models, start-frame image input).
export const openrouterI2VModels = [
  i2v('veo-3.1-fast', 'Google Veo 3.1 Fast', 'google/veo-3.1-fast'),
  i2v('kling-v3-pro', 'Kling v3.0 Pro', 'kwaivgi/kling-v3.0-pro'),
  i2v('grok-imagine', 'xAI Grok Imagine Video', 'x-ai/grok-imagine-video'),
  i2v('seedance-2.0', 'Seedance 2.0', 'bytedance/seedance-2.0'),
];

// OpenRouter image-generation models (output_modalities=image), via chat API.
export const openrouterImageModels = [
  { id: 'or-gemini-3-pro-image', name: 'Gemini 3 Pro Image', provider: 'openrouter', orModel: 'google/gemini-3-pro-image-preview' },
  { id: 'or-gemini-flash-image', name: 'Gemini 2.5 Flash Image', provider: 'openrouter', orModel: 'google/gemini-2.5-flash-image' },
  { id: 'or-gpt-image', name: 'GPT Image', provider: 'openrouter', orModel: 'openai/gpt-5-image' },
];

export const isOpenRouterModel = (model) => !!model && model.provider === 'openrouter';
