// Generic media generation — the ONE catalog of cloud sources, their models, and
// each provider's parameter dialect. Pure data + pure functions (renderer-safe),
// except makeGenerationAdapter, which builds a live adapter and therefore takes a
// key explicitly — core never reads key storage.
//
// Consumers: the MCP generate_image / generate_video tools, the story pipeline
// (story.js derives its IMAGE_SOURCES view from this so the two can't drift),
// and electron/lib bridges. The Image/Video studio tabs still carry their own
// older copies of these maps — migrate them here rather than editing in place.

import { falAdapter } from './adapters/fal.js';
import { agnesAdapter } from './adapters/agnes.js';

// Agnes throttles by PLAN, not per key-tier detection — the user tells us which
// plan they bought (Settings; defaults to free). Video status queries: free tier
// = 1 effective RPM (60s floor, produced a live 429 at the generic 4s default);
// Token Plan = 5 effective RPM (12s). See adapters/agnes.js for the saga.
export const AGNES_PLANS = {
  free: { label: 'Free — 1 video poll/min', videoPollMs: 60000 },
  token: { label: 'Token Plan — 5 video polls/min', videoPollMs: 12000 },
};

// Aspect → each provider's dialect. fal names presets; Agnes wants literal pixels
// (image) or width/height (video). Agnes's image endpoint 400s unless
// response_format sits INSIDE extra_body (their docs warn about this exact trap).
const FAL_IMAGE_SIZE = {
  '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '1:1': 'square_hd',
  '4:3': 'landscape_4_3', '3:4': 'portrait_4_3',
};
const AGNES_IMAGE_SIZE = {
  '16:9': '1024x576', '9:16': '576x1024', '1:1': '1024x1024',
  '4:3': '1024x768', '3:4': '768x1024',
};
const AGNES_VIDEO_SIZE = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 960, height: 960 },
};
const AGNES_FRAME_RATE = 24;
const AGNES_DEFAULT_FRAMES = 121;

// Model ids mirror the studio tabs' verified/unverified lists (2026-07).
// `video` = text-to-video; `video_i2v` = animate-an-image (fal publishes those as
// separate marketplace slugs; Agnes reuses one model with an optional image field).
export const GENERATION_SOURCES = [
  {
    id: 'fal',
    name: 'fal.ai',
    provider: 'fal',       // keychain id + providers.js id
    models: {
      image: [
        { id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell — fast & cheap' },
        { id: 'fal-ai/flux/dev', label: 'FLUX.1 dev — higher quality' },
      ],
      video: [
        { id: 'fal-ai/veo3', label: 'Veo 3 — text-to-video with audio (live-verified)' },
        { id: 'bytedance/seedance-2.0/text-to-video', label: 'Seedance 2.0 (unverified — verify live)' },
        { id: 'xai/grok-imagine-video/text-to-video', label: 'Grok Imagine Video (unverified — verify live)' },
      ],
      video_i2v: [
        { id: 'fal-ai/kling-video/v3/pro/image-to-video', label: 'Kling 3.0 Pro (unverified — verify live)' },
        { id: 'bytedance/seedance-2.0/image-to-video', label: 'Seedance 2.0 i2v (unverified — verify live)' },
        { id: 'fal-ai/pixverse/v6/image-to-video', label: 'PixVerse V6 (unverified — verify live)' },
      ],
    },
  },
  {
    id: 'agnes',
    name: 'Agnes AI',
    provider: 'agnes',
    models: {
      image: [
        { id: 'agnes-image-2.0-flash', label: 'Image 2.0 Flash' },
        { id: 'agnes-image-2.1-flash', label: 'Image 2.1 Flash' },
      ],
      video: [{ id: 'agnes-video-v2.0', label: 'Video v2.0' }],
      video_i2v: [{ id: 'agnes-video-v2.0', label: 'Video v2.0 — animate image' }],
    },
  },
];

export function getGenerationSource(id) {
  return GENERATION_SOURCES.find((s) => s.id === id) || null;
}

const modelList = (source, kind, { hasImage = false } = {}) =>
  (kind === 'video' && hasImage ? source.models.video_i2v : source.models[kind]) || [];

// The caller's model if this source actually offers it for this kind (a fal id is
// meaningless to Agnes; a t2v id may not exist as i2v), else the list's first.
export function resolveGenerationModel(sourceId, kind, modelId, { hasImage = false } = {}) {
  const source = getGenerationSource(sourceId);
  if (!source) return null;
  const list = modelList(source, kind, { hasImage });
  return list.some((m) => m.id === modelId) ? modelId : (list[0]?.id || null);
}

/**
 * The request body for one generation, in the provider's dialect. Pure — an input
 * image arrives as an already-encoded data URL (`image`), never a path.
 */
export function buildGenerationParams(sourceId, kind, { prompt, aspect = '16:9', durationSeconds = null, image = null } = {}) {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('buildGenerationParams: prompt is empty');

  if (kind === 'image') {
    return sourceId === 'agnes'
      ? { prompt: p, size: AGNES_IMAGE_SIZE[aspect] || AGNES_IMAGE_SIZE['16:9'], extra_body: { response_format: 'url' } }
      : { prompt: p, image_size: FAL_IMAGE_SIZE[aspect] || FAL_IMAGE_SIZE['16:9'] };
  }

  if (kind === 'video') {
    if (sourceId === 'agnes') {
      return {
        prompt: p,
        ...(AGNES_VIDEO_SIZE[aspect] || AGNES_VIDEO_SIZE['16:9']),
        frame_rate: AGNES_FRAME_RATE,
        num_frames: durationSeconds ? Math.round(durationSeconds * AGNES_FRAME_RATE) : AGNES_DEFAULT_FRAMES,
        ...(image ? { image } : {}),
      };
    }
    return {
      prompt: p,
      aspect_ratio: aspect,
      // fal's duration is a STRING of seconds (Seedance's confirmed schema); omit = provider default.
      ...(durationSeconds ? { duration: String(Math.round(durationSeconds)) } : {}),
      ...(image ? { image_url: image } : {}),
    };
  }

  throw new Error(`buildGenerationParams: unknown kind "${kind}"`);
}

/**
 * A live runJob adapter for the source. Key is explicit — never read from storage
 * here. agnesPlan picks the video poll rate ('free' default; see AGNES_PLANS).
 */
export function makeGenerationAdapter(sourceId, { key, model, kind, agnesPlan = 'free' } = {}) {
  if (sourceId === 'agnes') {
    const plan = AGNES_PLANS[agnesPlan] || AGNES_PLANS.free;
    return agnesAdapter({ key, model, kind, pollMs: kind === 'video' ? plan.videoPollMs : undefined });
  }
  if (sourceId === 'fal') return falAdapter({ model, key });
  throw new Error(`makeGenerationAdapter: unknown source "${sourceId}"`);
}
