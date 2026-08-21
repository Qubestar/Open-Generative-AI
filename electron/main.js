const { app, BrowserWindow, shell, nativeImage } = require('electron');
const path = require('path');

app.name = 'Vidmyo';
const { register: registerWan2gp } = require('./lib/wan2gpProvider');
const { register: registerAgents } = require('./lib/agents');
const { register: registerSecrets } = require('./lib/secrets');
const { register: registerNetProxy } = require('./lib/netProxy');
const { register: registerStory } = require('./lib/storyBridge');
const { register: registerMedia } = require('./lib/mediaBridge');
const { register: registerRepurpose, stop: stopRepurpose } = require('./lib/repurposeBridge');
const mcpHost = require('./lib/mcpHost');
const { resolveRuntimePaths } = require('./lib/runtimePaths');
const { createWebHost } = require('./lib/webHost');

// Ubuntu 24.04+ sets kernel.apparmor_restrict_unprivileged_userns=1 which
// blocks Chromium's user namespace sandbox. The .deb package ships an AppArmor
// profile that grants the permission cleanly. When running the AppImage on an
// affected system, run once: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
// or pass --no-sandbox on the command line.
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('disable-dev-shm-usage');
}

let mainWindow;
const runtime = resolveRuntimePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
const webHost = createWebHost();
let shutdownStarted = false;

async function createWindow() {
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

    // Development keeps the hot-reload launcher on :3210. Packaged builds own
    // a loopback-only Next standalone child and wait for /studio readiness.
    let rendererUrl = process.env.VIDMYO_DEV_URL || 'http://localhost:3210/studio';
    try {
        if (app.isPackaged) rendererUrl = (await webHost.start({ serverDir: runtime.webDir })).url;
    } catch (error) {
        const message = `Vidmyo could not start its packaged interface. ${String(error.message || error)}`;
        const html = `<title>Vidmyo startup error</title><body style="background:#0d0d0d;color:#f4f4f5;font-family:sans-serif;padding:40px"><h1>Vidmyo could not start</h1><p>${message}</p></body>`;
        rendererUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    }
    mainWindow.loadURL(rendererUrl).catch((err) => {
        console.error(`Failed to load Vidmyo renderer at ${rendererUrl.split('?')[0]}`, err);
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

app.whenReady().then(async () => {
    // Beat Wave dock icon (dev runs under the generic Electron binary).
    if (process.platform === 'darwin' && app.dock) {
        const icon = nativeImage.createFromPath(path.join(runtime.publicDir, 'vidmyo-icon.png'));
        if (!icon.isEmpty()) app.dock.setIcon(icon);
    }
    await createWindow();
    registerWan2gp();
    registerAgents();
    registerSecrets();
    registerNetProxy();
    registerStory();
    registerMedia();
    registerRepurpose();
    // Loopback MCP so agents can use keychain keys (image generation) while
    // Vidmyo is open. Best-effort: a failure here must never block the app.
    mcpHost.start().then((r) => {
        if (!r.ok) console.error('[mcp-host] not started:', r.error);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            void createWindow();
        }
    });
});

app.on('before-quit', (event) => {
    if (shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    Promise.allSettled([mcpHost.stop(), stopRepurpose(), webHost.stop()])
        .finally(() => app.quit());
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
