import { SettingsModal } from './SettingsModal.js';
import { getActiveProviderId, getProviderById } from '../lib/providers.js';

export function Header(navigate) {
    const header = document.createElement('header');
    header.className = 'w-full flex flex-col z-50 sticky top-0';

    // Active provider badge (re-renders when settings changes)
    const providerId = getActiveProviderId();
    const provider = getProviderById(providerId);

    const navBar = document.createElement('div');
    navBar.className = 'w-full h-16 bg-black flex items-center justify-between px-4 md:px-6 border-b border-white/5 backdrop-blur-md bg-opacity-95';

    const leftPart = document.createElement('div');
    leftPart.className = 'flex items-center gap-8';

    // Logo
    const logoContainer = document.createElement('div');
    logoContainer.className = 'cursor-pointer hover:scale-110 transition-transform';
    logoContainer.innerHTML = `
        <div class="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg overflow-hidden" style="background: linear-gradient(135deg,#111111,#1a0b2e);">
            <svg width="28" height="28" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="lv" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stop-color="#7c3aed"/>
                        <stop offset="100%" stop-color="#a855f7"/>
                    </linearGradient>
                    <linearGradient id="lc" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                        <stop offset="0%" stop-color="#f472b6"/>
                        <stop offset="100%" stop-color="#fb7185"/>
                    </linearGradient>
                </defs>
                <g transform="translate(10,12)">
                    <path d="M 2 4 L 20 4 L 16 14 L 2 14 Z" fill="url(#lv)" opacity="0.9"/>
                    <path d="M 6 16 L 22 16 L 18 26 L 6 26 Z" fill="url(#lc)" opacity="0.9"/>
                    <path d="M 26 4 L 42 4 L 42 14 L 30 14 Z" fill="url(#lc)" opacity="0.9"/>
                    <path d="M 28 16 L 44 16 L 38 26 L 28 26 Z" fill="url(#lv)" opacity="0.9"/>
                    <path d="M 24 10 L 36 19 L 24 28 Z" fill="white" opacity="0.95"/>
                </g>
            </svg>
        </div>
    `;

    const menu = document.createElement('nav');
    menu.className = 'hidden lg:flex items-center gap-6 text-[13px] font-bold text-secondary';
    const items = ['Image', 'Video', 'Lip Sync', 'Cinema Studio', 'Workflows', 'Agents', 'MCP & CLI'];

    items.forEach(item => {
        const link = document.createElement('a');
        link.textContent = item;
        link.className = `hover:text-white transition-all cursor-pointer relative group ${item === 'Image' ? 'text-white' : ''}`;

        // Active Indicator or Dot
        if (item === 'Image') {
            const dot = document.createElement('div');
            dot.className = 'absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full';
            link.appendChild(dot);
        }

        link.onclick = () => {
            // Remove active state from all
            Array.from(menu.children).forEach(child => child.classList.remove('text-white'));
            // Add to current
            link.classList.add('text-white');

            if (item === 'Image') navigate('image');
            else if (item === 'Video') navigate('video');
            else if (item === 'Lip Sync') navigate('lipsync');
            else if (item === 'Cinema Studio') navigate('cinema');
            else if (item === 'Workflows') navigate('workflows');
            else if (item === 'Agents') navigate('agents');
            else if (item === 'MCP & CLI') navigate('mcp-cli');
        };

        menu.appendChild(link);
    });

    leftPart.appendChild(logoContainer);
    leftPart.appendChild(menu);

    const rightPart = document.createElement('div');
    rightPart.className = 'flex items-center gap-4';

    // Provider badge
    const providerBadge = document.createElement('span');
    providerBadge.className = 'hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border';
    providerBadge.style.color = provider.color || '#7c3aed';
    providerBadge.style.borderColor = (provider.color || '#7c3aed') + '40';
    providerBadge.style.backgroundColor = (provider.color || '#7c3aed') + '10';
    providerBadge.textContent = provider.name;

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-md border border-white/10 bg-white/5 text-[13px] font-bold text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors';
    settingsBtn.title = 'Settings — API key, local models, preferences';
    settingsBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Settings</span>
    `;
    settingsBtn.onclick = () => {
        document.body.appendChild(SettingsModal());
    };

    rightPart.appendChild(providerBadge);
    rightPart.appendChild(settingsBtn);

    navBar.appendChild(leftPart);
    navBar.appendChild(rightPart);

    header.appendChild(navBar);

    return header;
}
