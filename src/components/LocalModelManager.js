import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';

// Local Models panel — Wan2GP only.
// The bundled sd.cpp engine and the Bonsai/ComfyUI bridges were removed
// 2026-07-03: Vidmyo's image quality bar is Google Flow + professional APIs;
// Wan2GP remains as the bring-your-own-GPU route for Flux/Qwen/video models.

const CheckIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`;

// ─── Wan2GP Server Config ────────────────────────────────────────────────────
function Wan2gpConfigBar(onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col gap-3 p-3 rounded-xl bg-white/3 border border-white/5';
    wrap.innerHTML = `
        <div class="flex flex-col gap-0.5">
            <span class="text-xs font-bold text-white">Wan2GP server (optional)</span>
            <span class="text-[11px] text-muted leading-relaxed">
                Run <a href="https://github.com/deepbeepmeep/Wan2GP" target="_blank" class="text-primary hover:underline">Wan2GP</a>
                on a CUDA box (<code class="text-primary/80">python wgp.py --listen --server-name 0.0.0.0</code>) to unlock Flux/Qwen image and Wan/Hunyuan/LTX video models from this UI.
            </span>
        </div>
        <div class="flex items-center gap-2">
            <input id="wan2gp-url" type="text" placeholder="http://127.0.0.1:7860"
                   class="flex-1 bg-white/5 border border-white/5 focus:border-primary/40 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none"/>
            <button id="wan2gp-test" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-all">Test</button>
            <button id="wan2gp-save" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-black hover:shadow-glow transition-all">Save</button>
        </div>
        <div id="wan2gp-status" class="text-[11px] text-muted">Not configured</div>
    `;

    const input = wrap.querySelector('#wan2gp-url');
    const testBtn = wrap.querySelector('#wan2gp-test');
    const saveBtn = wrap.querySelector('#wan2gp-save');
    const statusEl = wrap.querySelector('#wan2gp-status');
    const setStatus = (text, kind = 'muted') => {
        const colorMap = { muted: 'text-muted', ok: 'text-green-400', warn: 'text-yellow-400', err: 'text-red-400' };
        statusEl.className = `text-[11px] ${colorMap[kind] || colorMap.muted}`;
        statusEl.textContent = text;
    };

    (async () => {
        const cfg = await localAI.getWan2gpConfig();
        if (cfg.url) {
            input.value = cfg.url;
            const r = await localAI.probeWan2gp(cfg.url);
            setStatus(r.ok ? `Connected · Gradio ${r.version}` : `Saved URL not reachable: ${r.error}`, r.ok ? 'ok' : 'warn');
        } else {
            setStatus('Not configured (Wan2GP models will appear offline)', 'muted');
        }
    })();

    testBtn.onclick = async () => {
        const url = input.value.trim();
        if (!url) { setStatus('Enter a URL first', 'warn'); return; }
        setStatus('Probing...', 'muted');
        testBtn.disabled = true;
        try {
            const r = await localAI.probeWan2gp(url);
            setStatus(r.ok ? `Reachable · Gradio ${r.version}` : `Unreachable: ${r.error}`, r.ok ? 'ok' : 'err');
        } finally { testBtn.disabled = false; }
    };

    saveBtn.onclick = async () => {
        const url = input.value.trim();
        saveBtn.disabled = true;
        try {
            await localAI.setWan2gpUrl(url);
            const r = url ? await localAI.probeWan2gp(url) : { ok: false, error: 'cleared' };
            setStatus(r.ok ? `Saved · Connected to Gradio ${r.version}` : (url ? `Saved, not reachable: ${r.error}` : 'Cleared'), r.ok ? 'ok' : 'warn');
            onChange?.();
        } finally { saveBtn.disabled = false; }
    };

    return wrap;
}

// ─── Model Card ───────────────────────────────────────────────────────────────
function Wan2gpModelCard(model) {
    const card = document.createElement('div');
    card.className = 'flex items-start justify-between gap-3 p-4 rounded-xl border border-white/5 bg-white/3';
    const ready = !!model.ready;
    card.innerHTML = `
        <div class="flex flex-col gap-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-bold text-white truncate">${model.name}</span>
                ${ready ? `<span class="text-green-400">${CheckIcon}</span>` : ''}
            </div>
            <p class="text-[11px] text-muted leading-relaxed">${model.description}</p>
            <div class="flex items-center gap-1.5 flex-wrap mt-1">
                <span class="px-1.5 py-0.5 rounded-md text-[10px] font-bold ${model.type === 'video' ? 'bg-purple-500/15 text-purple-300' : 'bg-primary/10 text-primary'}">${model.type.toUpperCase()}</span>
                <span class="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-white/5 text-muted">via Wan2GP</span>
                ${(model.tags || []).filter(t => !['featured', 'remote'].includes(t)).map(t => `<span class="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-white/5 text-muted">${t}</span>`).join('')}
            </div>
        </div>
        <div class="shrink-0">
            <span class="text-[10px] font-bold ${ready ? 'text-green-400' : 'text-yellow-400'}">${ready ? 'Available' : 'Server offline'}</span>
        </div>
    `;
    return card;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function LocalModelManager() {
    const root = document.createElement('div');
    root.className = 'flex flex-col gap-5';

    if (!isLocalAIAvailable()) {
        root.innerHTML = `
            <div class="flex flex-col items-center gap-3 py-8 text-center">
                <p class="text-sm font-bold text-white">Local Models</p>
                <p class="text-xs text-muted max-w-xs">Local model inference is only available in the desktop app (Electron build). Use <span class="text-primary font-bold">npm run electron:build</span> to build.</p>
            </div>
        `;
        return root;
    }

    // ── Section: engine status
    const engineSection = document.createElement('div');
    engineSection.className = 'flex flex-col gap-2';
    engineSection.innerHTML = `<h3 class="text-xs font-bold text-secondary uppercase tracking-wider">Inference Server</h3>`;

    const wan2gpBar = Wan2gpConfigBar(() => renderModels());
    engineSection.appendChild(wan2gpBar);
    root.appendChild(engineSection);

    // ── Section: models
    const modelsSection = document.createElement('div');
    modelsSection.className = 'flex flex-col gap-3';
    modelsSection.innerHTML = `
        <div class="flex items-center justify-between">
            <h3 class="text-xs font-bold text-secondary uppercase tracking-wider">Wan2GP Models</h3>
            <span class="text-[10px] text-muted">Served by your Wan2GP box</span>
        </div>
        <div id="local-model-list" class="flex flex-col gap-3"></div>
    `;
    root.appendChild(modelsSection);

    const listEl = modelsSection.querySelector('#local-model-list');

    const renderModels = async () => {
        listEl.innerHTML = `<div class="text-xs text-muted text-center py-4">Loading...</div>`;
        try {
            const models = await localAI.listModels();
            listEl.innerHTML = '';
            if (!models.length) {
                listEl.innerHTML = `<div class="text-xs text-muted text-center py-4">No Wan2GP server connected. Configure one above to list its models.</div>`;
                return;
            }
            models.forEach(m => {
                listEl.appendChild(Wan2gpModelCard(m));
            });
        } catch (err) {
            listEl.innerHTML = `<div class="text-xs text-red-400 text-center py-4">Error loading models: ${err.message}</div>`;
        }
    };

    renderModels();

    return root;
}
