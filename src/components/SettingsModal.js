import { LocalModelManager } from './LocalModelManager.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
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

        // ── OAuth / Integration card: Connect + Launch buttons ──
        if (prov.type === 'oauth') {
            const isConn = getIntegrationConnected(prov.id);
            const status = document.createElement('div');
            status.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';
            status.innerHTML = `
                <span style="font-size:0.7rem;color:${isConn ? '#7c3aed' : 'rgba(255,255,255,0.3)'};">${isConn ? '● Connected' : '● Not connected'}</span>
                ${prov.cliCommand ? `<code style="font-size:0.65rem;color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">${prov.cliCommand}</code>` : ''}
            `;
            foot.appendChild(status);

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.25rem;';

            const connectBtn = document.createElement('button');
            connectBtn.textContent = isConn ? 'Disconnect' : 'Connect';
            connectBtn.style.cssText = `
                flex:1;padding:0.4rem 0.75rem;border-radius:0.5rem;border:1px solid rgba(255,255,255,0.1);
                background:${isConn ? 'rgba(255,255,255,0.05)' : (prov.color || '#7c3aed') + '20'};
                color:${isConn ? 'rgba(255,255,255,0.5)' : (prov.color || '#fff')};
                font-size:0.75rem;font-weight:700;cursor:pointer;
            `;
            connectBtn.onclick = (e) => {
                e.stopPropagation();
                if (isConn) {
                    setIntegrationConnected(prov.id, false);
                    localStorage.removeItem(`vidmyo_key_${prov.id}`);
                    // Refresh
                    switchTab('integrations');
                } else {
                    // Open auth/docs in new tab
                    window.open(prov.oauthUrl || prov.docsUrl, '_blank');
                    // Show a prompt for the API key since OAuth isn't real for CLI tools
                    const key = prompt(`Paste your ${prov.name} API key or access token:`);
                    if (key) {
                        setSavedProviderKey(prov.id, key.trim());
                        setIntegrationConnected(prov.id, true);
                    }
                    switchTab('integrations');
                }
            };

            const launchBtn = document.createElement('button');
            launchBtn.textContent = 'Launch CLI';
            launchBtn.style.cssText = `
                flex:1;padding:0.4rem 0.75rem;border-radius:0.5rem;border:1px solid rgba(255,255,255,0.1);
                background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);
                font-size:0.75rem;font-weight:700;cursor:pointer;
            `;
            launchBtn.title = prov.cliCommand || '';
            launchBtn.onclick = (e) => {
                e.stopPropagation();
                if (!prov.cliCommand) return;
                // Copy to clipboard
                navigator.clipboard.writeText(prov.cliCommand);
                launchBtn.textContent = 'Copied!';
                setTimeout(() => launchBtn.textContent = 'Launch CLI', 1200);
            };

            btnRow.appendChild(connectBtn);
            btnRow.appendChild(launchBtn);
            foot.appendChild(btnRow);
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
            const muapiKey = getSavedProviderKey('muapi');
            if (muapiKey) localStorage.setItem('muapi_key', muapiKey);
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

        integrationsPanel.appendChild(categoryHeader('Agent Integrations', intProvs.length));
        intProvs.forEach(p => integrationsPanel.appendChild(buildProviderCard(p)));

        const info = document.createElement('div');
        info.style.cssText = 'margin-top:0.75rem;padding:1rem;border-radius:0.5rem;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);';
        info.innerHTML = `
            <h4 style="font-size:0.75rem;font-weight:700;color:rgba(255,255,255,0.5);margin:0 0 0.5rem 0;">About Integrations</h4>
            <p style="font-size:0.7rem;color:rgba(255,255,255,0.35);margin:0;line-height:1.5;">
                Connect coding agents like Claude Code, Codex, and Hermes to enable AI-assisted workflows inside Vidmyo.
                These agents run locally on your machine via CLI. Click "Launch CLI" to copy the install command.
            </p>
        `;
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

    switchTab('providers');

    const close = () => {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
        if (onClose) onClose();
    };

    header.querySelector('#settings-close-btn').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.appendChild(modal);
    return overlay;
}
