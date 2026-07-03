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
    openExternal: (url) => ipcRenderer.invoke('agents:openExternal', url),
});
