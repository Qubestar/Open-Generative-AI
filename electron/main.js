const { app, BrowserWindow, shell, nativeImage } = require('electron');
const path = require('path');

app.name = 'Vidmyo';
const { register: registerWan2gp } = require('./lib/wan2gpProvider');
const { register: registerAgents } = require('./lib/agents');
const { register: registerSecrets } = require('./lib/secrets');
const { register: registerNetProxy } = require('./lib/netProxy');
const { register: registerStory } = require('./lib/storyBridge');
const { register: registerMedia } = require('./lib/mediaBridge');
const mcpHost = require('./lib/mcpHost');

// Ubuntu 24.04+ sets kernel.apparmor_restrict_unprivileged_userns=1 which
// blocks Chromium's user namespace sandbox. The .deb package ships an AppArmor
// profile that grants the permission cleanly. When running the AppImage on an
// affected system, run once: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
// or pass --no-sandbox on the command line.
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('disable-dev-shm-usage');
}

let mainWindow;

function createWindow() {
    const isMac = process.platform === 'darwin';

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        webPreferences: {
            // Cloud requests go through the main-process fetch proxy
            // (lib/netProxy.js), so the renderer keeps web security enabled.
            webSecurity: true,
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
        backgroundColor: '#0d0d0d',
        show: false,
        title: 'Vidmyo',
    });

    // The app IS the Next.js dev shell (hot reload) — the old bundled Vite
    // renderer was removed 2026-07-04. The launcher starts `npm run dev` on
    // :3210 and opens this window; VIDMYO_DEV_URL can point elsewhere.
    const devUrl = process.env.VIDMYO_DEV_URL || 'http://localhost:3210/studio';
    mainWindow.loadURL(devUrl).catch((err) => {
        console.error(`Failed to load ${devUrl} — is the dev server running? (npm run dev -- -p 3210)`, err);
        mainWindow.show();
    });

    mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
        console.error('did-fail-load:', code, desc);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // Beat Wave dock icon (dev runs under the generic Electron binary).
    if (process.platform === 'darwin' && app.dock) {
        const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'vidmyo-icon.png'));
        if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
    createWindow();
    registerWan2gp();
    registerAgents();
    registerSecrets();
    registerNetProxy();
    registerStory();
    registerMedia();
    // Loopback MCP so agents can use keychain keys (image generation) while
    // Vidmyo is open. Best-effort: a failure here must never block the app.
    mcpHost.start().then((r) => {
        if (!r.ok) console.error('[mcp-host] not started:', r.error);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('will-quit', () => { mcpHost.stop(); });

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
