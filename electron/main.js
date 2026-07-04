const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { register: registerWan2gp } = require('./lib/wan2gpProvider');
const { register: registerAgents } = require('./lib/agents');
const { register: registerSecrets } = require('./lib/secrets');
const { register: registerNetProxy } = require('./lib/netProxy');
const { register: registerStory } = require('./lib/storyBridge');

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

    // Dev: load the live Next dev server (hot-reloading, all latest changes) when
    // VIDMYO_DEV_URL is set. Production: load the bundled Vite build as before.
    const devUrl = process.env.VIDMYO_DEV_URL;
    if (devUrl) {
        mainWindow.loadURL(devUrl).catch((err) => {
            console.error('Failed to load dev URL:', err);
            mainWindow.show();
        });
    } else {
        const indexPath = path.join(__dirname, '../dist/index.html');
        mainWindow.loadFile(indexPath).catch((err) => {
            console.error('Failed to load index.html:', err);
            mainWindow.show();
        });
    }

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
    createWindow();
    registerWan2gp();
    registerAgents();
    registerSecrets();
    registerNetProxy();
    registerStory();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
