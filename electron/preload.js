const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAI', {
    isElectron: true,

    // ── sd.cpp engine ──────────────────────────────────────────────────────
    getBinaryStatus: () => ipcRenderer.invoke('local-ai:binary-status'),
    downloadBinary: () => ipcRenderer.invoke('local-ai:download-binary'),

    listModels: () => ipcRenderer.invoke('local-ai:list-models'),
    downloadModel: (modelId) => ipcRenderer.invoke('local-ai:download-model', modelId),
    downloadAuxiliary: (auxKey) => ipcRenderer.invoke('local-ai:download-auxiliary', auxKey),
    deleteModel: (modelId) => ipcRenderer.invoke('local-ai:delete-model', modelId),
    cancelDownload: (modelId) => ipcRenderer.invoke('local-ai:cancel-download', modelId),

    generate: (params) => ipcRenderer.invoke('local-ai:generate', params),
    cancelGeneration: () => ipcRenderer.invoke('local-ai:cancel-generation'),

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

    // ── Bonsai Image Studio (local FastAPI backend) ───────────────────────
    bonsai: {
        getConfig:  () => ipcRenderer.invoke('bonsai:get-config'),
        setUrl:     (url) => ipcRenderer.invoke('bonsai:set-url', url),
        probe:      (url) => ipcRenderer.invoke('bonsai:probe', url),
        listModels: () => ipcRenderer.invoke('bonsai:list-models'),
        generate:   (params) => ipcRenderer.invoke('bonsai:generate', params),
    },

    // ── ComfyUI (local checkpoint server) ─────────────────────────────────
    comfyui: {
        getConfig:  () => ipcRenderer.invoke('comfyui:get-config'),
        setUrl:     (url) => ipcRenderer.invoke('comfyui:set-url', url),
        probe:      (url) => ipcRenderer.invoke('comfyui:probe', url),
        listModels: () => ipcRenderer.invoke('comfyui:list-models'),
        generate:   (params) => ipcRenderer.invoke('comfyui:generate', params),
    },

    // Progress events — both engines emit on local-ai:progress
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:progress', listener);
        return () => ipcRenderer.removeListener('local-ai:progress', listener);
    },
    onDownloadProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('local-ai:download-progress', listener);
        return () => ipcRenderer.removeListener('local-ai:download-progress', listener);
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
    openExternal: (url) => ipcRenderer.invoke('agents:openExternal', url),
});
