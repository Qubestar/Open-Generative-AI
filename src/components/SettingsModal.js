import { LocalModelManager } from './LocalModelManager.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import {
    getAllProviders,
    getActiveProviderId,
    setActiveProviderId,
    getSavedProviderKey,
    setSavedProviderKey,
    buildProviderHeaders,
} from '../lib/providers.js';

export function SettingsModal(onClose) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:100;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card,#111);border-radius:1rem;border:1px solid rgba(255,255,255,0.08);width:min(90vw,40rem);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

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

    // ── Provider Panel ──
    const providersPanel = document.createElement('div');
    providersPanel.style.cssText = 'display:flex;flex-direction:column;gap:1rem;';

    const providers = getAllProviders();
    let activeProvider = getActiveProviderId();

    const providerCards = [];

    function saveProviderKey(pid, key) {
        setSavedProviderKey(pid, key.trim());
    }

    providers.forEach((prov) => {
        const card = document.createElement('div');
        card.style.cssText = `
            border:1px solid rgba(255,255,255,0.08);
            border-radius:0.75rem;
            padding:1rem;
            background:rgba(255,255,255,0.02);
            transition:all 0.15s;
            cursor:pointer;
        `;
        const isActive = activeProvider === prov.id;
        if (isActive) {
            card.style.borderColor = (prov.color || '#7c3aed') + '80';
            card.style.background = (prov.color || '#7c3aed') + '08';
        }

        card.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;">
                <div style="display:flex;align-items:center;gap:0.6rem;">
                    <div style="width:10px;height:10px;border-radius:50%;background:${prov.color || '#fff'};box-shadow:0 0 8px ${prov.color || '#fff'}40;"></div>
                    <span style="font-size:0.85rem;font-weight:700;color:#fff;">${prov.name}</span>
                </div>
                <div style="font-size:0.7rem;color:rgba(255,255,255,0.35);">${prov.type === 'aggregator' ? 'Aggregator' : 'Direct API'}</div>
            </div>
            <p style="font-size:0.75rem;color:rgba(255,255,255,0.45);margin:0.4rem 0 0.75rem 0;line-height:1.4;">${prov.description}</p>
            <div style="display:flex;flex-direction:column;gap:0.5rem;">
                <input type="password" data-pid="${prov.id}" placeholder="Enter ${prov.name} API key..." value="${getSavedProviderKey(prov.id) || ''}"
                    style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:0.5rem;padding:0.5rem 0.75rem;color:#fff;font-size:0.8rem;outline:none;" />
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <a href="${prov.docsUrl}" target="_blank" style="font-size:0.7rem;color:rgba(255,255,255,0.35);text-decoration:none;">Get key →</a>
                    <span class="status-dot" style="font-size:0.7rem;color:rgba(255,255,255,0.3);"></span>
                </div>
            </div>
        `;

        const input = card.querySelector(`input[data-pid="${prov.id}"]`);
        input.addEventListener('input', () => saveProviderKey(prov.id, input.value));
        input.addEventListener('click', (e) => e.stopPropagation());

        const statusDot = card.querySelector('.status-dot');
        function updateStatus() {
            const hasKey = !!(getSavedProviderKey(prov.id) || '').trim();
            statusDot.textContent = hasKey ? '● Ready' : '● Not set';
            statusDot.style.color = hasKey ? '#7c3aed' : 'rgba(255,255,255,0.3)';
        }
        updateStatus();
        input.addEventListener('input', updateStatus);

        card.addEventListener('click', () => {
            activeProvider = prov.id;
            setActiveProviderId(prov.id);
            providerCards.forEach((c, i) => {
                const p = providers[i];
                if (providers[i].id === prov.id) {
                    c.style.borderColor = (p.color || '#7c3aed') + '80';
                    c.style.background = (p.color || '#7c3aed') + '08';
                } else {
                    c.style.borderColor = 'rgba(255,255,255,0.08)';
                    c.style.background = 'rgba(255,255,255,0.02)';
                }
            });
        });

        providersPanel.appendChild(card);
        providerCards.push(card);
    });

    // Note row
    const note = document.createElement('p');
    note.style.cssText = 'font-size:0.7rem;color:rgba(255,255,255,0.3);margin:0;';
    note.textContent = 'Your API keys are stored locally in your browser and never sent to our servers.';
    providersPanel.appendChild(note);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.25rem;';
    btnRow.innerHTML = `
        <button id="prov-cancel" style="padding:0.5rem 1rem;border-radius:0.5rem;background:none;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-size:0.75rem;font-weight:700;cursor:pointer;">Cancel</button>
        <button id="prov-save" style="padding:0.5rem 1rem;border-radius:0.5rem;background:var(--color-primary,#7c3aed);color:#000;font-size:0.75rem;font-weight:700;cursor:pointer;border:none;">Save</button>
    `;
    providersPanel.appendChild(btnRow);

    // ── Local Models Panel ──
    const localPanel = LocalModelManager();

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

        if (id === 'providers') body.appendChild(providersPanel);
        if (id === 'local' && isLocalAIAvailable()) body.appendChild(localPanel);
    };

    switchTab('providers');

    const close = () => {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
        if (onClose) onClose();
    };

    providersPanel.querySelector('#prov-cancel').onclick = close;
    providersPanel.querySelector('#prov-save').onclick = () => {
        providerCards.forEach((card) => {
            const input = card.querySelector('input[type="password"]');
            if (input) setSavedProviderKey(input.dataset.pid, input.value.trim());
        });
        // Update legacy muapi key for backward compat
        const muapiKey = getSavedProviderKey('muapi');
        if (muapiKey) localStorage.setItem('muapi_key', muapiKey);
        close();
    };

    header.querySelector('#settings-close-btn').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.appendChild(modal);
    return overlay;
}
