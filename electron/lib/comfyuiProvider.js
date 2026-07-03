// ComfyUI provider for locally installed checkpoints.
// Uses ComfyUI's HTTP API when the user has the local server running.

const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(app.getPath('userData'), 'local-ai');
const CONFIG_FILE = path.join(DATA_DIR, 'comfyui.json');
const DEFAULT_URL = 'http://127.0.0.1:8188';
const DEFAULT_COMFY_DIR = '/Users/look/Documents/comfy/ComfyUI';

fs.mkdirSync(DATA_DIR, { recursive: true });

const COMFYUI_CATALOG = [
    {
        id: 'comfyui:sd15-pruned-ema',
        name: 'Stable Diffusion 1.5 (ComfyUI)',
        description: 'Installed ComfyUI checkpoint. Start ComfyUI, then generate locally from Vidmyo.',
        type: 'image',
        family: 'stable-diffusion',
        provider: 'comfyui',
        checkpoint: 'v1-5-pruned-emaonly.safetensors',
        modelPath: path.join(DEFAULT_COMFY_DIR, 'models/checkpoints/v1-5-pruned-emaonly.safetensors'),
        sizeGB: 4.0,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        defaultSteps: 20,
        defaultGuidance: 7.5,
        tags: ['installed', 'local', 'sd15', 'comfyui'],
    },
];

function normalizeUrl(url) { return (url || '').trim().replace(/\/+$/, ''); }

function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return { url: DEFAULT_URL, comfyDir: DEFAULT_COMFY_DIR };
    try {
        return { url: DEFAULT_URL, comfyDir: DEFAULT_COMFY_DIR, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
    } catch {
        return { url: DEFAULT_URL, comfyDir: DEFAULT_COMFY_DIR };
    }
}

function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        url: normalizeUrl(cfg.url || DEFAULT_URL),
        comfyDir: cfg.comfyDir || DEFAULT_COMFY_DIR,
    }, null, 2));
}

async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
}

async function probe(url) {
    const base = normalizeUrl(url || readConfig().url || DEFAULT_URL);
    if (!base) return { ok: false, error: 'URL is empty' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
        const res = await fetchJson(`${base}/system_stats`, { signal: ac.signal });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} from /system_stats` };
        return { ok: true, url: base, system: res.body?.system || {}, devices: res.body?.devices || [] };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function listModels() {
    const cfg = readConfig();
    const status = await probe(cfg.url);
    return COMFYUI_CATALOG.map(model => {
        const installed = fs.existsSync(model.modelPath);
        return {
            ...model,
            ready: installed && status.ok,
            installed,
            url: normalizeUrl(cfg.url),
            unavailableReason: !installed
                ? `Checkpoint not found at ${model.modelPath}`
                : (!status.ok ? `ComfyUI offline: ${status.error}` : 'ComfyUI unavailable'),
        };
    });
}

function arToDimensions(ar) {
    const map = {
        '1:1': [512, 512],
        '4:3': [640, 480],
        '3:4': [480, 640],
        '16:9': [768, 432],
        '9:16': [432, 768],
    };
    return map[ar] || map['1:1'];
}

function buildWorkflow({ model, prompt, negativePrompt, width, height, steps, cfg, seed }) {
    return {
        '1': {
            class_type: 'CheckpointLoaderSimple',
            inputs: { ckpt_name: model.checkpoint },
        },
        '2': {
            class_type: 'CLIPTextEncode',
            inputs: { text: prompt, clip: ['1', 1] },
        },
        '3': {
            class_type: 'CLIPTextEncode',
            inputs: { text: negativePrompt || '', clip: ['1', 1] },
        },
        '4': {
            class_type: 'EmptyLatentImage',
            inputs: { width, height, batch_size: 1 },
        },
        '5': {
            class_type: 'KSampler',
            inputs: {
                seed,
                steps,
                cfg,
                sampler_name: 'euler',
                scheduler: 'normal',
                denoise: 1,
                model: ['1', 0],
                positive: ['2', 0],
                negative: ['3', 0],
                latent_image: ['4', 0],
            },
        },
        '6': {
            class_type: 'VAEDecode',
            inputs: { samples: ['5', 0], vae: ['1', 2] },
        },
        '7': {
            class_type: 'SaveImage',
            inputs: { filename_prefix: 'vidmyo', images: ['6', 0] },
        },
    };
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function generate(params, mainWindow) {
    const cfg = readConfig();
    const base = normalizeUrl(cfg.url);
    const model = COMFYUI_CATALOG.find(m => m.id === params.model);
    if (!model) throw new Error(`Unknown ComfyUI model: ${params.model}`);
    if (!fs.existsSync(model.modelPath)) throw new Error(`ComfyUI checkpoint not found at ${model.modelPath}`);

    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    send({ status: 'starting', progress: 0 });

    const [width, height] = arToDimensions(params.aspect_ratio || '1:1');
    const seed = params.seed && params.seed !== -1 ? params.seed : Math.floor(Math.random() * 2147483647);
    const steps = params.steps || model.defaultSteps || 20;
    const workflow = buildWorkflow({
        model,
        prompt: params.prompt || '',
        negativePrompt: params.negative_prompt,
        width,
        height,
        steps,
        cfg: params.guidance_scale ?? model.defaultGuidance ?? 7.5,
        seed,
    });

    const queued = await fetchJson(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
    });
    if (!queued.ok || !queued.body?.prompt_id) {
        throw new Error(`ComfyUI queue failed: HTTP ${queued.status}`);
    }
    const promptId = queued.body.prompt_id;

    for (let i = 0; i < 900; i++) {
        send({ status: 'generating', progress: Math.min(0.95, 0.05 + i / 900) });
        await sleep(1000);
        const history = await fetchJson(`${base}/history/${promptId}`).catch(() => null);
        const entry = history?.body?.[promptId];
        const images = entry?.outputs?.['7']?.images;
        if (Array.isArray(images) && images[0]) {
            const img = images[0];
            const url = `${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`;
            send({ status: 'done', progress: 1 });
            return { url, mediaType: 'image', seed };
        }
    }
    throw new Error('ComfyUI generation timed out');
}

function getMainWindow() { return BrowserWindow.getAllWindows()[0] || null; }

function register() {
    ipcMain.handle('comfyui:get-config', () => readConfig());
    ipcMain.handle('comfyui:set-url', (_, url) => { writeConfig({ ...readConfig(), url }); return { ok: true }; });
    ipcMain.handle('comfyui:probe', (_, url) => probe(url));
    ipcMain.handle('comfyui:list-models', () => listModels());
    ipcMain.handle('comfyui:generate', (_, params) => generate(params, getMainWindow()));
}

module.exports = { register, COMFYUI_CATALOG };
