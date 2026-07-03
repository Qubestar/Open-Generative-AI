import { LocalModelManager } from './LocalModelManager.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { agentsClient, isAgentBridgeAvailable } from '../lib/agentsClient.js';
import {
    PROVIDER_CATEGORIES,
    getAllProviders,
    getProvidersByCategory,
    getActiveProviderId,
    setActiveProviderId,
    getSavedProviderKey,
    setSavedProviderKey,
    getIntegrationConnected,
    setIntegrationConnected,
} from '../lib/providers.js';

export function SettingsModal(onClose) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:100;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card,#111);border-radius:1rem;border:1px solid rgba(255,255,255,0.08);width:min(90vw,44rem);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

    // ── Header ──
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';
    header.innerHTML = `
        <h2 style="font-size:1rem;font-weight:800;color:#fff;margin:0;">Settings</h2>
        <button id="settings-close-btn" style="color:rgba(255,255,255,0.4);background:none;border:none;cursor:pointer;padding:4px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
    `;
    modal.appendChild(header);

    // ── Tabs ──
    const TABS = [
        { id: 'providers', label: 'Providers' },
        { id: 'integrations', label: 'Integrations' },
        { id: 'local', label: 'Local Models' },
    ];

    let activeTab = 'providers';

    // Real detection results from the Electron agent bridge, keyed by provider id.
    // Populated lazily when the Integrations tab is opened in the desktop app.
    let agentInfo = {};
    let agentDetectStarted = false;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:0.25rem;padding:0.75rem 1.5rem 0;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';

    const tabBtns = {};
    TABS.forEach(({ id, label }) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'padding:0.4rem 0.75rem;border-radius:0.5rem 0.5rem 0 0;font-size:0.75rem;font-weight:700;border:none;cursor:pointer;transition:all 0.15s;';
        btn.onclick = () => switchTab(id);
        tabBtns[id] = btn;
        tabBar.appendChild(btn);
    });
    modal.appendChild(tabBar);

    // ── Body ──
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:1.5rem;';
    modal.appendChild(body);

    // ── Helper: create category header ──
    function categoryHeader(label, count) {
        const h = document.createElement('div');
        h.style.cssText = 'display:flex;align-items:baseline;gap:0.5rem;margin:0.5rem 0 0.75rem;';
        h.innerHTML = `
            <span style="font-size:0.7rem;font-weight:800;color:rgba(255,255,255,0.45);text-transform:uppercase;letter-spacing:0.05em;">${label}</span>
            <span style="font-size:0.65rem;color:rgba(255,255,255,0.2);">${count}</span>
        `;
        return h;
    }

    // ── Helper: build provider card ──
    function buildProviderCard(prov) {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem;padding:1rem;background:rgba(255,255,255,0.02);transition:all 0.15s;cursor:pointer;';

        const isActive = getActiveProviderId() === prov.id;
        if (isActive) {
            card.style.borderColor = (prov.color || '#7c3aed') + '80';
            card.style.background = (prov.color || '#7c3aed') + '08';
        }

        const typeLabel = prov.type === 'aggregator' ? 'Aggregator'
            : prov.type === 'oauth' ? 'CLI Integration'
            : prov.category === 'budget' ? 'Budget API'
            : 'Direct API';

        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;">
                <div style="display:flex;align-items:center;gap:0.6rem;">
                    <div style="width:10px;height:10px;border-radius:50%;background:${prov.color || '#fff'};box-shadow:0 0 8px ${prov.color || '#fff'}40;"></div>
                    <span style="font-size:0.85rem;font-weight:700;color:#fff;">${prov.name}</span>
                </div>
                <div style="font-size:0.7rem;color:rgba(255,255,255,0.35);">${typeLabel}</div>
            </div>
            <p style="font-size:0.75rem;color:rgba(255,255,255,0.45);margin:0.4rem 0 0.75rem 0;line-height:1.4;">${prov.description}</p>
            <div class="card-foot" style="display:flex;flex-direction:column;gap:0.5rem;"></div>
        `;

        const foot = card.querySelector('.card-foot');

        // ── OAuth / Integration card ──
        if (prov.type === 'oauth' && isAgentBridgeAvailable()) {
            buildRealAgentFoot(prov, foot);
        }
        else if (prov.type === 'oauth') {
            buildFallbackAgentFoot(prov, foot);
        }
        // ── Direct / Aggregator card: API key input ──
        else {
            const input = document.createElement('input');
            input.type = 'password';
            input.dataset.pid = prov.id;
            input.placeholder = `Enter ${prov.name} API key...`;
            input.value = getSavedProviderKey(prov.id) || '';
            input.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:0.5rem;padding:0.5rem 0.75rem;color:#fff;font-size:0.8rem;outline:none;';
            input.addEventListener('input', () => setSavedProviderKey(prov.id, input.value.trim()));
            input.addEventListener('click', (e) => e.stopPropagation());
            foot.appendChild(input);

            const infoRow = document.createElement('div');
            infoRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
            infoRow.innerHTML = `
                <a href="${prov.docsUrl}" target="_blank" style="font-size:0.7rem;color:rgba(255,255,255,0.35);text-decoration:none;">Get key →</a>
                <span class="status-dot" style="font-size:0.7rem;color:rgba(255,255,255,0.3);"></span>
            `;
            foot.appendChild(infoRow);

            const statusDot = infoRow.querySelector('.status-dot');
            function updateStatus() {
                const hasKey = !!(getSavedProviderKey(prov.id) || '').trim();
                statusDot.textContent = hasKey ? '● Ready' : '● Not set';
                statusDot.style.color = hasKey ? '#7c3aed' : 'rgba(255,255,255,0.3)';
            }
            updateStatus();
            input.addEventListener('input', updateStatus);
        }

        // Click card body (not buttons/inputs) → set active provider
        card.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'A') return;
            setActiveProviderId(prov.id);
            // Refresh panel to highlight
            if (activeTab === 'providers') switchTab('providers');
        });

        return card;
    }

    // ── Helper: small pill button used in agent cards ──
    function mkAgentBtn(label, prov, primary) {
        const btn = document.createElement('button');
        btn.textContent = label;
        const accent = prov.color || '#7c3aed';
        btn.style.cssText = `
            flex:1;min-width:7rem;padding:0.4rem 0.75rem;border-radius:0.5rem;border:1px solid rgba(255,255,255,0.1);
            background:${primary ? accent + '20' : 'rgba(255,255,255,0.05)'};
            color:${primary ? accent : 'rgba(255,255,255,0.5)'};
            font-size:0.72rem;font-weight:700;cursor:pointer;white-space:nowrap;
        `;
        return btn;
    }

    // ── Helper: status line built with textContent (no innerHTML) ──
    function mkStatusLine(label, labelColor, versionText) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;';
        const dot = document.createElement('span');
        dot.style.cssText = `font-size:0.7rem;color:${labelColor};`;
        dot.textContent = `● ${label}`;
        wrap.appendChild(dot);
        if (versionText) {
            const code = document.createElement('code');
            code.style.cssText = 'font-size:0.62rem;color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;';
            code.textContent = `v${versionText}`;
            wrap.appendChild(code);
        }
        return wrap;
    }

    // ── Real agent card (desktop app) — uses the Electron bridge ──
    function buildRealAgentFoot(prov, foot) {
        const info = agentInfo[prov.id];
        const accent = prov.color || '#7c3aed';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.25rem;flex-wrap:wrap;';

        if (!info) {
            foot.appendChild(mkStatusLine('Checking…', 'rgba(255,255,255,0.3)'));
            return;
        }

        if (!info.installed) {
            foot.appendChild(mkStatusLine('Not installed on this Mac', 'rgba(255,255,255,0.3)'));
            const installBtn = mkAgentBtn('Install guide', prov, true);
            installBtn.onclick = (e) => { e.stopPropagation(); agentsClient.openExternal(prov.docsUrl); };
            const copyBtn = mkAgentBtn('Copy install cmd', prov, false);
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(info.installCmd || prov.cliCommand || '');
                copyBtn.textContent = 'Copied!';
                setTimeout(() => (copyBtn.textContent = 'Copy install cmd'), 1200);
            };
            btnRow.appendChild(installBtn);
            btnRow.appendChild(copyBtn);
            foot.appendChild(btnRow);
            return;
        }

        const connected = info.authed;
        foot.appendChild(mkStatusLine(
            connected ? 'Connected' : 'Installed · not signed in',
            connected ? accent : 'rgba(255,255,255,0.55)',
            info.version,
        ));

        const connectBtn = mkAgentBtn(connected ? 'Re-login' : 'Connect', prov, !connected);
        connectBtn.onclick = async (e) => {
            e.stopPropagation();
            const prev = connectBtn.textContent;
            connectBtn.textContent = 'Opening terminal…';
            const r = await agentsClient.login(prov.id);
            connectBtn.textContent = r && r.ok ? 'Terminal opened ✓' : 'Failed';
            setTimeout(() => { connectBtn.textContent = prev; switchTab('integrations'); }, 1600);
        };

        const launchBtn = mkAgentBtn('Launch', prov, false);
        launchBtn.onclick = async (e) => {
            e.stopPropagation();
            launchBtn.textContent = 'Opening…';
            await agentsClient.launch(prov.id);
            setTimeout(() => (launchBtn.textContent = 'Launch'), 1200);
        };

        const skillsBtn = mkAgentBtn('Set up media skills', prov, false);
        skillsBtn.onclick = async (e) => {
            e.stopPropagation();
            skillsBtn.textContent = 'Opening…';
            await agentsClient.setupMediaSkills({ muapiKey: getSavedProviderKey('muapi') });
            setTimeout(() => (skillsBtn.textContent = 'Set up media skills'), 1400);
        };

        btnRow.appendChild(connectBtn);
        btnRow.appendChild(launchBtn);
        btnRow.appendChild(skillsBtn);
        foot.appendChild(btnRow);
    }

    // ── Fallback agent card (browser / hosted) — original link-out flow ──
    function buildFallbackAgentFoot(prov, foot) {
        const isConn = getIntegrationConnected(prov.id);
        foot.appendChild(mkStatusLine(
            isConn ? 'Connected — Desktop app only' : 'Not connected — Desktop app only',
            isConn ? '#7c3aed' : 'rgba(255,255,255,0.3)',
        ));

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.25rem;';

        const connectBtn = mkAgentBtn(isConn ? 'Disconnect' : 'Connect', prov, !isConn);
        connectBtn.onclick = (e) => {
            e.stopPropagation();
            if (isConn) {
                setIntegrationConnected(prov.id, false);
                localStorage.removeItem(`vidmyo_key_${prov.id}`);
                switchTab('integrations');
            } else {
                window.open(prov.oauthUrl || prov.docsUrl, '_blank');
                const key = prompt(`Paste your ${prov.name} API key or access token:`);
                if (key) {
                    setSavedProviderKey(prov.id, key.trim());
                    setIntegrationConnected(prov.id, true);
                }
                switchTab('integrations');
            }
        };

        const launchBtn = mkAgentBtn('Copy CLI', prov, false);
        launchBtn.title = prov.cliCommand || '';
        launchBtn.onclick = (e) => {
            e.stopPropagation();
            if (!prov.cliCommand) return;
            navigator.clipboard.writeText(prov.cliCommand);
            launchBtn.textContent = 'Copied!';
            setTimeout(() => (launchBtn.textContent = 'Copy CLI'), 1200);
        };

        btnRow.appendChild(connectBtn);
        btnRow.appendChild(launchBtn);
        foot.appendChild(btnRow);
    }

    // ── Providers Panel (grouped by category) ──
    const providersPanel = document.createElement('div');
    providersPanel.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;';

    function renderProvidersPanel() {
        providersPanel.innerHTML = '';
        const all = getAllProviders();
        const nonInt = all.filter(p => p.type !== 'oauth');
        const cats = PROVIDER_CATEGORIES.filter(c => c.id !== 'integration');

        cats.forEach(cat => {
            const provs = nonInt.filter(p => p.category === cat.id);
            if (!provs.length) return;
            providersPanel.appendChild(categoryHeader(cat.label, provs.length));
            provs.forEach(p => providersPanel.appendChild(buildProviderCard(p)));
        });

        // Note row
        const note = document.createElement('p');
        note.style.cssText = 'font-size:0.7rem;color:rgba(255,255,255,0.3);margin:0.5rem 0 0 0;';
        note.textContent = 'Your API keys are stored locally in your browser and never sent to our servers.';
        providersPanel.appendChild(note);

        // Save / Cancel
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.5rem;';
        btnRow.innerHTML = `
            <button id="prov-cancel" style="padding:0.5rem 1rem;border-radius:0.5rem;background:none;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-size:0.75rem;font-weight:700;cursor:pointer;">Cancel</button>
            <button id="prov-save" style="padding:0.5rem 1rem;border-radius:0.5rem;background:var(--color-primary,#7c3aed);color:#fff;font-size:0.75rem;font-weight:700;cursor:pointer;border:none;">Save</button>
        `;
        providersPanel.appendChild(btnRow);

        btnRow.querySelector('#prov-cancel').onclick = close;
        btnRow.querySelector('#prov-save').onclick = () => {
            nonInt.forEach(p => {
                const inpt = providersPanel.querySelector(`input[data-pid="${p.id}"]`);
                if (inpt) setSavedProviderKey(p.id, inpt.value.trim());
            });
            close();
        };
    }

    // ── Integrations Panel ──
    const integrationsPanel = document.createElement('div');
    integrationsPanel.style.cssText = 'display:flex;flex-direction:column;gap:0.5rem;';

    function renderIntegrationsPanel() {
        integrationsPanel.innerHTML = '';
        const intProvs = getAllProviders().filter(p => p.type === 'oauth');
        if (!intProvs.length) {
            integrationsPanel.innerHTML = '<p style="font-size:0.8rem;color:rgba(255,255,255,0.3);text-align:center;padding:2rem;">No integrations available yet.</p>';
            return;
        }

        // In the desktop app, scan the machine for installed agent CLIs once,
        // then re-render with real status. In the browser this is skipped.
        if (isAgentBridgeAvailable() && !agentDetectStarted) {
            agentDetectStarted = true;
            agentsClient.detect().then((res) => {
                if (res && res.ok && Array.isArray(res.agents)) {
                    res.agents.forEach((a) => { agentInfo[a.id] = a; });
                }
                if (activeTab === 'integrations') renderIntegrationsPanel();
            });
        }

        integrationsPanel.appendChild(categoryHeader('Agent Integrations', intProvs.length));
        intProvs.forEach(p => integrationsPanel.appendChild(buildProviderCard(p)));

        const info = document.createElement('div');
        info.style.cssText = 'margin-top:0.75rem;padding:1rem;border-radius:0.5rem;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);';
        const infoBody = isAgentBridgeAvailable()
            ? 'Vidmyo detects coding agents already installed on this Mac (Claude Code, Codex, Gemini, Hermes, OpenCode). "Connect" opens that agent\'s own sign-in (e.g. <code>codex login</code> runs the real OpenAI OAuth). "Set up media skills" installs the Generative-Media-Skills wired to your Muapi key so the agent can generate images and video from its terminal.'
            : 'Connect coding agents like Claude Code, Codex, and Gemini to enable AI-assisted media workflows. Detection, sign-in, and launching require the Vidmyo desktop app.';
        const h4 = document.createElement('h4');
        h4.style.cssText = 'font-size:0.75rem;font-weight:700;color:rgba(255,255,255,0.5);margin:0 0 0.5rem 0;';
        h4.textContent = 'About Integrations';
        const p = document.createElement('p');
        p.style.cssText = 'font-size:0.7rem;color:rgba(255,255,255,0.35);margin:0;line-height:1.5;';
        p.innerHTML = infoBody; // static, app-authored copy only
        info.appendChild(h4);
        info.appendChild(p);
        integrationsPanel.appendChild(info);

        // Save / Cancel
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.5rem;';
        btnRow.innerHTML = `
            <button id="int-cancel" style="padding:0.5rem 1rem;border-radius:0.5rem;background:none;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-size:0.75rem;font-weight:700;cursor:pointer;">Close</button>
        `;
        integrationsPanel.appendChild(btnRow);
        btnRow.querySelector('#int-cancel').onclick = close;
    }

    // ── Local Models Panel ──
    const localPanel = LocalModelManager ? LocalModelManager() : document.createElement('div');
    if (localPanel) {
        localPanel.innerHTML = '<p style="font-size:0.8rem;color:rgba(255,255,255,0.3);text-align:center;padding:2rem;">Local model support coming soon.</p>';
    }

    // ── Tab switching ──
    const switchTab = (id) => {
        activeTab = id;
        body.innerHTML = '';

        TABS.forEach(({ id: tid }) => {
            const btn = tabBtns[tid];
            if (tid === id) {
                btn.style.background = 'rgba(255,255,255,0.08)';
                btn.style.color = '#fff';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = 'rgba(255,255,255,0.4)';
            }
        });

        if (id === 'providers') {
            renderProvidersPanel();
            body.appendChild(providersPanel);
        }
        if (id === 'integrations') {
            renderIntegrationsPanel();
            body.appendChild(integrationsPanel);
        }
        if (id === 'local') {
            if (isLocalAIAvailable && isLocalAIAvailable()) {
                body.appendChild(localPanel);
            } else {
                const empty = document.createElement('div');
                empty.innerHTML = '<p style="font-size:0.8rem;color:rgba(255,255,255,0.3);text-align:center;padding:2rem;">Local model support coming soon.</p>';
                body.appendChild(empty);
            }
        }
    };

    // `close` must be defined BEFORE the first switchTab() call: renderProvidersPanel
    // (and renderIntegrationsPanel) bind `onclick = close`, and the initial
    // switchTab('providers') runs that render. Declaring it later left `close` in
    // its temporal dead zone, throwing "Cannot access 'close' before initialization"
    // and silently preventing the Settings modal from ever opening.
    const close = () => {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
        if (onClose) onClose();
    };

    switchTab('providers');

    header.querySelector('#settings-close-btn').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.appendChild(modal);
    return overlay;
}
