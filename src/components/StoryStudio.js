// Story Studio — the flagship faceless-video workflow (doodle template first).
// Desktop-only: all state lives in the project.json manifest on disk; this UI
// talks to @vidmyo/core in the main process through window.story (see
// electron/lib/storyBridge.js). Stage logic and gates live in core — this
// component only renders status and forwards actions.

const LAST_DIR_KEY = 'vidmyo_story_last_dir';

const STAGE_LABELS = {
    script: 'Script',
    voiceover: 'Voiceover (Kokoro)',
    beats: 'Beats & scenes',
    prompts: 'Image prompts',
    images: 'Scene images',
    assemble: 'Assemble',
    finalize: 'Finalize (4K + −14 LUFS)',
};

export function StoryStudio() {
    const root = document.createElement('div');
    root.className = 'flex-1 overflow-y-auto p-6 md:p-10';

    if (typeof window === 'undefined' || !window.story?.isElectron) {
        root.innerHTML = `
            <div class="max-w-lg mx-auto text-center py-20 flex flex-col gap-3">
                <h2 class="text-xl font-black text-white">Story Studio</h2>
                <p class="text-sm text-muted">Story Studio runs the local pipeline (TTS, beat detection, ffmpeg) and is only available in the desktop app.</p>
            </div>`;
        return root;
    }

    let projectDir = localStorage.getItem(LAST_DIR_KEY) || null;
    let summary = null;       // last story:get payload
    let readiness = null;
    let busyStage = null;

    const container = document.createElement('div');
    container.className = 'max-w-4xl mx-auto flex flex-col gap-5';
    root.appendChild(container);

    const progressLog = [];
    window.story.onProgress((p) => {
        progressLog.push(p);
        if (p.phase !== 'start') busyStage = null;
        render();
    });

    // ── Actions ──────────────────────────────────────────────────────────────
    async function refresh() {
        if (projectDir) {
            summary = await window.story.get(projectDir);
            if (!summary.ok) { projectDir = null; summary = null; }
        }
        readiness = await window.story.readiness();
        render();
    }

    async function createProject(topic) {
        const picked = await window.story.pickDir();
        if (!picked.ok || !picked.dir) return;
        const res = await window.story.create({ dir: picked.dir, brief: { topic } });
        if (res.ok) {
            projectDir = res.dir;
            localStorage.setItem(LAST_DIR_KEY, projectDir);
            summary = res;
        } else {
            alert(res.error);
        }
        render();
    }

    async function openProject() {
        const picked = await window.story.pickDir();
        if (!picked.ok || !picked.dir) return;
        const res = await window.story.get(picked.dir);
        if (res.ok) {
            projectDir = res.dir;
            localStorage.setItem(LAST_DIR_KEY, projectDir);
            summary = res;
        } else {
            alert(`Not a story project: ${res.error}`);
        }
        render();
    }

    async function runStage(stage, opts = {}) {
        busyStage = stage;
        render();
        const res = await window.story.runStage(projectDir, stage, opts);
        busyStage = null;
        if (res.ok) summary = res;
        else alert(res.error);
        render();
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    const el = (html) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.firstElementChild;
    };

    function renderEmpty() {
        const card = el(`
            <div class="flex flex-col items-center gap-4 py-16 text-center">
                <h2 class="text-2xl font-black text-white">Story Studio</h2>
                <p class="text-sm text-muted max-w-md">Create a complete faceless doodle video: script → voiceover → beat-cut scenes → images → assembled MP4. Everything is saved in a project folder you can resume anytime.</p>
                <input id="story-topic" type="text" placeholder="Topic, e.g. Why you wake up at 2am"
                       class="w-80 bg-white/5 border border-white/10 focus:border-primary/40 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none"/>
                <div class="flex gap-3">
                    <button id="story-create" class="px-5 py-2.5 rounded-xl text-sm font-bold bg-primary text-black hover:shadow-glow transition-all">Create project…</button>
                    <button id="story-open" class="px-5 py-2.5 rounded-xl text-sm font-bold bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-all">Open existing…</button>
                </div>
            </div>`);
        card.querySelector('#story-create').onclick = () =>
            createProject(card.querySelector('#story-topic').value.trim() || 'untitled');
        card.querySelector('#story-open').onclick = openProject;
        return card;
    }

    function renderReadinessBanner() {
        if (!readiness || readiness.ok === false || readiness.missing?.length === 0) return null;
        const banner = el(`
            <div class="flex flex-col gap-2 p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/30">
                <span class="text-xs font-bold text-yellow-400">Pipeline not ready</span>
                <ul class="text-[11px] text-muted list-disc pl-4">${(readiness.missing || []).map(m => `<li>${m}</li>`).join('')}</ul>
                <div class="flex gap-2 items-center">
                    <button id="setup-env" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">Install pipeline environment (large download)</button>
                    <button id="set-venv" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-white border border-white/10">Use existing venv…</button>
                </div>
            </div>`);
        banner.querySelector('#setup-env').onclick = async () => {
            if (!confirm('This creates a Python environment and downloads Kokoro TTS + whisper models (several hundred MB, one time). Continue?')) return;
            busyStage = 'setup-env';
            render();
            const res = await window.story.setupEnv();
            busyStage = null;
            if (!res.ok) alert(res.error);
            refresh();
        };
        banner.querySelector('#set-venv').onclick = async () => {
            const p = prompt('Path to an existing venv python (…/.venv/bin/python):', readiness.venvPython || '');
            if (!p) return;
            const res = await window.story.setVenv(p);
            if (!res.ok) alert(res.error);
            refresh();
        };
        return banner;
    }

    function renderStages(status) {
        const rows = Object.entries(STAGE_LABELS).map(([stage, label]) => {
            const done = status[stage];
            const isNext = status.nextStage === stage;
            return `
                <div class="flex items-center justify-between px-4 py-2.5 rounded-xl ${isNext ? 'bg-primary/10 border border-primary/30' : 'bg-white/3 border border-white/5'}">
                    <div class="flex items-center gap-3">
                        <span class="${done ? 'text-green-400' : 'text-white/25'}">${done ? '✓' : '○'}</span>
                        <span class="text-sm ${done ? 'text-white' : 'text-muted'} font-bold">${label}</span>
                        ${isNext ? '<span class="text-[10px] font-black text-primary uppercase tracking-widest">next</span>' : ''}
                    </div>
                    <div class="flex gap-2" data-stage-actions="${stage}"></div>
                </div>`;
        }).join('');
        const wrap = el(`<div class="flex flex-col gap-2">${rows}</div>`);

        const btn = (label, onclick, primary = false) => {
            const b = document.createElement('button');
            b.textContent = busyStage ? 'Working…' : label;
            b.disabled = !!busyStage;
            b.className = primary
                ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-black disabled:opacity-40'
                : 'px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 border border-white/10 text-white disabled:opacity-40';
            b.onclick = onclick;
            return b;
        };

        const status_ = summary.status;
        const slot = (s) => wrap.querySelector(`[data-stage-actions="${s}"]`);
        if (status_.script && !status_.voiceover) slot('voiceover').appendChild(btn('Generate voiceover', () => runStage('voiceover'), true));
        if (status_.voiceover && !status_.beats) slot('beats').appendChild(btn('Detect beats', () => runStage('beats'), true));
        if (status_.beats && !status_.assemble) {
            slot('assemble').appendChild(btn('Preview (white frames)', () => runStage('assemble', { allowMissing: true })));
            if (status_.images) slot('assemble').appendChild(btn('Assemble', () => runStage('assemble'), true));
        }
        if (status_.assemble && !status_.finalize && status_.images) {
            slot('finalize').appendChild(btn('Finalize', () => runStage('finalize'), true));
        }
        return wrap;
    }

    function renderScript() {
        const m = summary.manifest;
        const check = summary.scriptCheck;
        const wrap = el(`
            <div class="flex flex-col gap-2 p-4 rounded-xl bg-white/3 border border-white/5">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-bold text-secondary uppercase tracking-wider">Script</span>
                    <span class="text-[11px] ${check?.ok ? 'text-green-400' : 'text-yellow-400'}">
                        ${check ? `${check.words} words ${check.ok ? '— ready' : `(need ≥ ${check.minWords} for a 5:00+ video)`}` : ''}
                    </span>
                </div>
                <textarea id="story-script" rows="8" placeholder="Paste or write the narration script here. Use your agent with the master prompt (packages/core/pipelines/doodle/references/master-prompt.txt) to draft one."
                          class="w-full bg-black/30 border border-white/10 focus:border-primary/40 rounded-xl p-3 text-[13px] leading-relaxed text-white placeholder-white/25 focus:outline-none font-mono">${m.script ? m.script.replace(/</g, '&lt;') : ''}</textarea>
                <div class="flex justify-end"><button id="save-script" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white">Save script</button></div>
            </div>`);
        wrap.querySelector('#save-script').onclick = async () => {
            const res = await window.story.setScript(projectDir, wrap.querySelector('#story-script').value);
            if (res.ok) summary = res; else alert(res.error);
            render();
        };
        return wrap;
    }

    function renderScenes() {
        const scenes = summary.manifest.scenes;
        if (!scenes.length) return null;
        const wrap = el(`
            <div class="flex flex-col gap-2 p-4 rounded-xl bg-white/3 border border-white/5">
                <span class="text-xs font-bold text-secondary uppercase tracking-wider">Scenes (${scenes.length}) — attach and approve each image</span>
                <div id="scene-rows" class="flex flex-col gap-1.5"></div>
            </div>`);
        const rowsEl = wrap.querySelector('#scene-rows');
        for (const s of scenes) {
            const state = s.image.approved ? '✓ approved' : (s.image.artifact ? 'needs approval' : 'no image');
            const color = s.image.approved ? 'text-green-400' : (s.image.artifact ? 'text-yellow-400' : 'text-white/30');
            const row = el(`
                <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-black/20">
                    <span class="text-[11px] font-black text-primary w-10">${s.id}</span>
                    <span class="text-[12px] text-muted flex-1 truncate" title="${(s.prompt || '').replace(/"/g, '&quot;')}">${s.beat || '(no beat text)'}</span>
                    <span class="text-[10px] font-bold ${color} w-24 text-right">${state}</span>
                    <button data-act="copy" class="px-2 py-1 rounded text-[10px] font-bold bg-white/5 text-white border border-white/10" title="Copy the image prompt (paste into Google Flow — the free path)">Prompt</button>
                    <button data-act="attach" class="px-2 py-1 rounded text-[10px] font-bold bg-white/5 text-white border border-white/10">Attach…</button>
                    ${!s.image.artifact ? '<button data-act="generate" class="px-2 py-1 rounded text-[10px] font-bold bg-white/5 text-white border border-white/10" title="Generate with your fal.ai key — paid per image">fal ⚡</button>' : ''}
                    ${s.image.artifact && !s.image.approved ? '<button data-act="approve" class="px-2 py-1 rounded text-[10px] font-bold bg-primary text-black">Approve</button>' : ''}
                </div>`);
            row.querySelector('[data-act="copy"]').onclick = () => {
                navigator.clipboard.writeText(s.prompt || '');
            };
            const genBtn = row.querySelector('[data-act="generate"]');
            if (genBtn) genBtn.onclick = async () => {
                genBtn.disabled = true;
                genBtn.textContent = '…';
                const res = await window.story.generateScene(projectDir, s.id);
                if (res.ok) { summary = res; render(); }
                else { alert(res.error); genBtn.disabled = false; genBtn.textContent = 'fal ⚡'; }
            };
            row.querySelector('[data-act="attach"]').onclick = async () => {
                const res = await window.story.attachImage(projectDir, s.id);
                if (res.ok) { summary = res; render(); }
                else if (res.error !== 'cancelled') alert(res.error);
            };
            const approveBtn = row.querySelector('[data-act="approve"]');
            if (approveBtn) approveBtn.onclick = async () => {
                const res = await window.story.approveScene(projectDir, s.id);
                if (res.ok) { summary = res; render(); } else alert(res.error);
            };
            rowsEl.appendChild(row);
        }
        return wrap;
    }

    function renderProgress() {
        if (!progressLog.length) return null;
        const last = progressLog.slice(-4).map(p =>
            `<div class="text-[11px] ${p.phase === 'error' ? 'text-red-400' : 'text-muted'}">${p.stage}: ${p.phase}${p.message ? ` — ${p.message}` : ''}</div>`
        ).join('');
        return el(`<div class="flex flex-col gap-1 px-4 py-3 rounded-xl bg-black/30 border border-white/5">${last}</div>`);
    }

    function render() {
        container.innerHTML = '';
        if (!summary) {
            container.appendChild(renderEmpty());
            const banner = renderReadinessBanner();
            if (banner) container.appendChild(banner);
            return;
        }
        const m = summary.manifest;
        container.appendChild(el(`
            <div class="flex items-center justify-between">
                <div class="flex flex-col">
                    <h2 class="text-xl font-black text-white">${m.brief?.topic || 'Story project'}</h2>
                    <span class="text-[11px] text-muted">${projectDir} · style ${m.style} · ${m.aspect}</span>
                </div>
                <button id="switch-project" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 border border-white/10 text-white">Switch project…</button>
            </div>`));
        container.querySelector('#switch-project').onclick = openProject;

        const banner = renderReadinessBanner();
        if (banner) container.appendChild(banner);
        const progress = renderProgress();
        if (progress) container.appendChild(progress);
        container.appendChild(renderStages(summary.status));
        container.appendChild(renderScript());
        const scenes = renderScenes();
        if (scenes) container.appendChild(scenes);

        const finalized = m.renders.find(r => r.finalized);
        if (finalized) {
            container.appendChild(el(`
                <div class="px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/30 text-sm text-green-300 font-bold">
                    Final video ready: <span class="font-mono text-[12px]">${finalized.finalPath}</span>
                </div>`));
        }
    }

    render();
    refresh();
    return root;
}
