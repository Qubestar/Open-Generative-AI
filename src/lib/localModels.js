// Frontend-side local model catalog.
// One provider remains:
//   - wan2gp: user-run remote Gradio server (bring-your-own GPU box)
// Bundled low-quality local image generation (sd.cpp SD1.5/SDXL, Bonsai,
// ComfyUI SD1.5) was removed 2026-07-03 — Vidmyo targets high-quality image
// sources only (Google Flow, professional APIs, agents). Wan2GP stays because
// it serves modern models (Flux, Qwen Image, Wan 2.2, Hunyuan, LTX) on the
// user's own server. Mirrors electron/lib/wan2gpProvider.js.
export const LOCAL_MODEL_CATALOG = [
    // ── Wan2GP: image models ────────────────────────────────────────────────
    {
        id: 'wan2gp:flux-dev',
        name: 'Flux.1 Dev (Wan2GP)',
        description: 'Image — FLUX.1 dev served by Wan2GP. Requires running Wan2GP server.',
        type: 'image',
        family: 'flux',
        provider: 'wan2gp',
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        defaultSteps: 28,
        defaultGuidance: 3.5,
        tags: ['image', 'flux', 'remote'],
    },
    {
        id: 'wan2gp:qwen-image',
        name: 'Qwen Image (Wan2GP)',
        description: 'Image — Qwen-Image text-to-image served by Wan2GP.',
        type: 'image',
        family: 'qwen',
        provider: 'wan2gp',
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        defaultSteps: 30,
        defaultGuidance: 4.0,
        tags: ['image', 'qwen', 'remote'],
    },
    // ── Wan2GP: video models ────────────────────────────────────────────────
    {
        id: 'wan2gp:wan22-t2v',
        name: 'Wan 2.2 (Text-to-Video)',
        description: 'Video — Wan 2.2 text-to-video. Slow on consumer GPUs.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        aspectRatios: ['16:9', '1:1', '9:16'],
        defaultSteps: 25,
        defaultGuidance: 5.0,
        tags: ['video', 'wan', 'text-to-video'],
    },
    {
        id: 'wan2gp:wan22-i2v',
        name: 'Wan 2.2 (Image-to-Video)',
        description: 'Video — Wan 2.2 image-to-video. Provide a start frame.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        needsImage: true,
        aspectRatios: ['16:9', '1:1', '9:16'],
        defaultSteps: 25,
        defaultGuidance: 5.0,
        tags: ['video', 'wan', 'image-to-video'],
    },
    {
        id: 'wan2gp:hunyuan-video',
        name: 'Hunyuan Video (Wan2GP)',
        description: 'Video — Hunyuan text-to-video via Wan2GP.',
        type: 'video',
        family: 'hunyuan',
        provider: 'wan2gp',
        aspectRatios: ['16:9', '1:1', '9:16'],
        defaultSteps: 30,
        defaultGuidance: 6.0,
        tags: ['video', 'hunyuan'],
    },
    {
        id: 'wan2gp:ltx-video',
        name: 'LTX Video (Wan2GP)',
        description: 'Video — LTX text-to-video. Fastest video option in Wan2GP.',
        type: 'video',
        family: 'ltx',
        provider: 'wan2gp',
        aspectRatios: ['16:9', '1:1', '9:16'],
        defaultSteps: 20,
        defaultGuidance: 3.0,
        tags: ['video', 'ltx', 'fast'],
    },
];

export function getLocalModelById(id) {
    return LOCAL_MODEL_CATALOG.find(m => m.id === id) || null;
}

export const isWan2gpModelId = (id) => getLocalModelById(id)?.provider === 'wan2gp';
export const isLocalModelId  = (id) => !!getLocalModelById(id);

export const localT2VModels = LOCAL_MODEL_CATALOG.filter(m => m.provider === 'wan2gp' && m.type === 'video' && !m.needsImage);
export const localI2VModels = LOCAL_MODEL_CATALOG.filter(m => m.provider === 'wan2gp' && m.type === 'video' &&  m.needsImage);
