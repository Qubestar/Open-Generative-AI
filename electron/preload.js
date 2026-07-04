const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAI', {
    isElectron: true,

    // ── Wan2GP engine (remote Gradio server) ───────────────────────────────
    wan2gp: {
        getConfig:  () => ipcRenderer.invoke('wan2gp:get-config'),
        setUrl:     (url) => ipcRenderer.invoke('wan2gp:set-url', url),
        probe:      (url) => ipcRenderer.invoke('wan2gp:probe', url),
        listModels: () => ipcRenderer.invoke('wan2gp:list-models'),
        generate:   (params) => ipcRenderer.invoke('wan2gp:generate', params),
        cancelGeneration: () => ipcRenderer.invoke('wan2gp:cancel-generation'),
        uploadFile: (payload) => ipcRenderer.invoke('wan2gp:upload-file', payload),
    },

    // Progress events — Wan2GP emits on local-ai:progress
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:progress', listener);
        return () => ipcRenderer.removeListener('local-ai:progress', listener);
    },
});

// ── Secure provider key store (OS keychain via safeStorage) ────────────────
contextBridge.exposeInMainWorld('secureKeys', {
    isElectron: true,
    isAvailable: () => ipcRenderer.invoke('secrets:available'),
    getAll: () => ipcRenderer.invoke('secrets:get-all'),
    set: (id, key) => ipcRenderer.invoke('secrets:set', id, key),
});

// ── Main-process fetch proxy (keeps renderer webSecurity on) ───────────────
contextBridge.exposeInMainWorld('localNet', {
    isElectron: true,
    fetch: (req) => ipcRenderer.invoke('net:fetch', req),
});

// ── Cloud media bridge (fal via core job runner, keychain key) ──────────────
contextBridge.exposeInMainWorld('media', {
    isElectron: true,
    generate: (opts) => ipcRenderer.invoke('media:generate', opts),
    readFile: (p) => ipcRenderer.invoke('media:read-file', p),
    recent: (opts) => ipcRenderer.invoke('media:recent', opts),
    reveal: (p) => ipcRenderer.invoke('media:reveal', p),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('media:progress', listener);
        return () => ipcRenderer.removeListener('media:progress', listener);
    },
});

// ── Story Studio bridge (core runs in the main process) ─────────────────────
contextBridge.exposeInMainWorld('story', {
    isElectron: true,
    pickDir: () => ipcRenderer.invoke('story:pick-dir'),
    create: (opts) => ipcRenderer.invoke('story:create', opts),
    sheetRows: () => ipcRenderer.invoke('story:sheet-rows'),
    setSheet: (input) => ipcRenderer.invoke('story:set-sheet', input),
    createFromSheet: (opts) => ipcRenderer.invoke('story:create-from-sheet', opts),
    get: (dir) => ipcRenderer.invoke('story:get', dir),
    setScript: (dir, text) => ipcRenderer.invoke('story:set-script', dir, text),
    runStage: (dir, stage, opts) => ipcRenderer.invoke('story:run-stage', dir, stage, opts),
    approveScene: (dir, sceneId) => ipcRenderer.invoke('story:approve-scene', dir, sceneId),
    attachImage: (dir, sceneId) => ipcRenderer.invoke('story:attach-image', dir, sceneId),
    generateScene: (dir, sceneId, opts) => ipcRenderer.invoke('story:generate-scene', dir, sceneId, opts),
    readFile: (dir, filePath) => ipcRenderer.invoke('story:read-file', dir, filePath),
    readiness: () => ipcRenderer.invoke('story:readiness'),
    setVenv: (venvPython) => ipcRenderer.invoke('story:set-venv', venvPython),
    setupEnv: () => ipcRenderer.invoke('story:setup-env'),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('story:progress', listener);
        return () => ipcRenderer.removeListener('story:progress', listener);
    },
});

// ── Local AI agent bridge ───────────────────────────────────────────────────
// Detect/connect/launch coding agents already installed on the machine, and
// bootstrap media-generation skills. See electron/lib/agents.js.
contextBridge.exposeInMainWorld('agents', {
    isElectron: true,
    detect: () => ipcRenderer.invoke('agents:detect'),
    authStatus: (agentId) => ipcRenderer.invoke('agents:authStatus', agentId),
    login: (agentId) => ipcRenderer.invoke('agents:login', agentId),
    launch: (agentId, cwd) => ipcRenderer.invoke('agents:launch', agentId, cwd),
    setupMediaSkills: (opts) => ipcRenderer.invoke('agents:setupMediaSkills', opts),
    installMcp: (agentId) => ipcRenderer.invoke('agents:installMcp', agentId),
    getLaunchConfig: () => ipcRenderer.invoke('agents:getLaunchConfig'),
    setLaunchConfig: (cfg) => ipcRenderer.invoke('agents:setLaunchConfig', cfg),
    openExternal: (url) => ipcRenderer.invoke('agents:openExternal', url),
});
