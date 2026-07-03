// Bonsai Image Studio provider.
// Talks to the locally installed PrismML Bonsai FastAPI backend started by
// /Volumes/My Lexar/AI Projects/Bonsai-Image-Demo/scripts/serve.sh.

const { ipcMain, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(app.getPath('userData'), 'local-ai');
const CONFIG_FILE = path.join(DATA_DIR, 'bonsai.json');
const OUTPUT_DIR = path.join(DATA_DIR, 'bonsai-outputs');
const DEFAULT_URL = 'http://127.0.0.1:8000';
const DEFAULT_DEMO_DIR = '/Volumes/My Lexar/AI Projects/Bonsai-Image-Demo';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const BONSAI_CATALOG = [
    {
        id: 'bonsai:image-4b-ternary-mlx',
        name: 'Bonsai Image 4B Ternary',
        description: 'Installed local FLUX-style image model from PrismML. Runs through Bonsai Image Studio on Apple Silicon.',
        type: 'image',
        family: 'bonsai',
        provider: 'bonsai',
        backend: 'bonsai-ternary-mlx',
        repoPath: DEFAULT_DEMO_DIR,
        modelPath: path.join(DEFAULT_DEMO_DIR, 'models/bonsai-image-4B-ternary-mlx'),
        sizeGB: 4.0,
        aspectRatios: ['1:1', '3:2', '2:3', '16:9', '9:16', '2:1', '1:2'],
        defaultSteps: 4,
        defaultGuidance: 3.5,
        tags: ['installed', 'local', 'flux', 'apple-silicon'],
        featured: true,
    },
];

function normalizeUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
}

function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return { url: DEFAULT_URL, repoPath: DEFAULT_DEMO_DIR };
    try {
        return { url: DEFAULT_URL, repoPath: DEFAULT_DEMO_DIR, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
    } catch {
        return { url: DEFAULT_URL, repoPath: DEFAULT_DEMO_DIR };
    }
}

function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        url: normalizeUrl(cfg.url || DEFAULT_URL),
        repoPath: cfg.repoPath || DEFAULT_DEMO_DIR,
    }, null, 2));
}

function repoReady(repoPath) {
    return fs.existsSync(path.join(repoPath, 'scripts/serve.sh'))
        && fs.existsSync(path.join(repoPath, 'models/bonsai-image-4B-ternary-mlx'));
}

async function fetchJson(url, { timeoutMs = 5000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        return { ok: res.ok, status: res.status, body };
    } finally {
        clearTimeout(timer);
    }
}

async function probe(url) {
    const base = normalizeUrl(url || readConfig().url || DEFAULT_URL);
    if (!base) return { ok: false, error: 'URL is empty' };
    try {
        const res = await fetchJson(`${base}/backends`, { timeoutMs: 5000 });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} from /backends` };
        const backends = res.body || {};
        const supported = Array.isArray(backends.supported_families) ? backends.supported_families : [];
        return {
            ok: true,
            url: base,
            kind: backends.kind || 'unknown',
            defaultBackend: backends.default
                || (backends.default_family && backends.kind ? `${backends.default_family}-${backends.kind}` : null),
            supportedFamilies: supported,
            healthy: backends.healthy !== false,
            reason: backends.reason || null,
        };
    } catch (err) {
        return { ok: false, error: err.name === 'AbortError' ? 'Request timed out' : err.message };
    }
}

async function listModels() {
    const cfg = readConfig();
    const status = await probe(cfg.url);
    const installed = repoReady(cfg.repoPath);
    return BONSAI_CATALOG.map((model) => {
        const modelInstalled = fs.existsSync(model.modelPath) || installed;
        return {
            ...model,
            ready: status.ok && status.healthy && modelInstalled,
            installed: modelInstalled,
            url: normalizeUrl(cfg.url),
            repoPath: cfg.repoPath,
            unavailableReason: !modelInstalled
                ? `Bonsai model folder not found at ${model.modelPath}`
                : (!status.ok ? `Bonsai backend offline: ${status.error}` : (status.reason || 'Bonsai backend unavailable')),
        };
    });
}

function arToDimensions(ar) {
    const map = {
        '1:1': [1024, 1024],
        '3:2': [1248, 832],
        '2:3': [832, 1248],
        '16:9': [1344, 768],
        '9:16': [768, 1344],
        '2:1': [1408, 704],
        '1:2': [704, 1408],
        '4:3': [1152, 864],
        '3:4': [864, 1152],
    };
    return map[ar] || map['1:1'];
}

async function activeBackend(base) {
    const status = await probe(base);
    if (!status.ok) return null;
    return status.defaultBackend || 'bonsai-ternary-mlx';
}

async function generate(params, mainWindow) {
    const cfg = readConfig();
    const base = normalizeUrl(cfg.url);
    const model = BONSAI_CATALOG.find(m => m.id === params.model);
    if (!model) throw new Error(`Unknown Bonsai model: ${params.model}`);
    if (!repoReady(cfg.repoPath)) throw new Error(`Bonsai install not found at ${cfg.repoPath}`);

    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    send({ status: 'starting', progress: 0 });

    const [width, height] = arToDimensions(params.aspect_ratio || '1:1');
    const seed = params.seed && params.seed !== -1 ? params.seed : Math.floor(Math.random() * 2147483647);
    const steps = params.steps || model.defaultSteps || 4;
    const backend = await activeBackend(base);
    if (!backend) throw new Error(`Bonsai backend is offline. Start ${path.join(cfg.repoPath, 'scripts/serve.sh')} first.`);

    const payload = {
        prompt: params.prompt || '',
        seed,
        steps,
        height,
        width,
        guidance: params.guidance_scale ?? model.defaultGuidance ?? 3.5,
        backend,
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60 * 60 * 1000);
    try {
        send({ status: 'generating', progress: 0.15 });
        const res = await fetch(`${base}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ac.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Bonsai HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        const outPath = path.join(OUTPUT_DIR, `bonsai-${Date.now()}-seed${seed}.png`);
        fs.writeFileSync(outPath, bytes);
        send({ status: 'done', progress: 1 });
        return {
            url: `data:image/png;base64,${bytes.toString('base64')}`,
            mediaType: 'image',
            seed,
            path: outPath,
        };
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Bonsai generation timed out or was cancelled');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function getMainWindow() { return BrowserWindow.getAllWindows()[0] || null; }

function register() {
    ipcMain.handle('bonsai:get-config', () => readConfig());
    ipcMain.handle('bonsai:set-url', (_, url) => { writeConfig({ ...readConfig(), url }); return { ok: true }; });
    ipcMain.handle('bonsai:probe', (_, url) => probe(url));
    ipcMain.handle('bonsai:list-models', () => listModels());
    ipcMain.handle('bonsai:generate', (_, params) => generate(params, getMainWindow()));
}

module.exports = { register, BONSAI_CATALOG };
