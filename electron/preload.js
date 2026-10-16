const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    authorizeGeneration: (opts) => ipcRenderer.invoke('media:authorize-generation', opts),
    readFile: (p) => ipcRenderer.invoke('media:read-file', p),
    recent: (opts) => ipcRenderer.invoke('media:recent', opts),
    listJobs: (opts) => ipcRenderer.invoke('media:list-jobs', opts),
    resumeJob: (jobId) => ipcRenderer.invoke('media:resume-job', jobId),
    cancelJob: (jobId) => ipcRenderer.invoke('media:cancel-job', jobId),
    reveal: (p) => ipcRenderer.invoke('media:reveal', p),
    pickImage: () => ipcRenderer.invoke('media:pick-image'),
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
    getBase: () => ipcRenderer.invoke('story:get-base'),
    setBase: () => ipcRenderer.invoke('story:set-base'),
    createFromSheet: (opts) => ipcRenderer.invoke('story:create-from-sheet', opts),
    delegateSheetRow: (opts) => ipcRenderer.invoke('story:delegate-sheet-row', opts),
    get: (dir) => ipcRenderer.invoke('story:get', dir),
    setScript: (dir, text) => ipcRenderer.invoke('story:set-script', dir, text),
    runStage: (dir, stage, opts) => ipcRenderer.invoke('story:run-stage', dir, stage, opts),
    approveScene: (dir, sceneId) => ipcRenderer.invoke('story:approve-scene', dir, sceneId),
    attachImage: (dir, sceneId) => ipcRenderer.invoke('story:attach-image', dir, sceneId),
    generateScene: (dir, sceneId, opts) => ipcRenderer.invoke('story:generate-scene', dir, sceneId, opts),
    getImageConfig: () => ipcRenderer.invoke('story:get-image-config'),
    setImageConfig: (cfg) => ipcRenderer.invoke('story:set-image-config', cfg),
    readFile: (dir, filePath) => ipcRenderer.invoke('story:read-file', dir, filePath),
    readiness: () => ipcRenderer.invoke('story:readiness'),
    setVenv: (venvPython) => ipcRenderer.invoke('story:set-venv', venvPython),
    setupEnv: () => ipcRenderer.invoke('story:setup-env'),
    googleAccount: () => ipcRenderer.invoke('story:google-account'),
    googleConnect: () => ipcRenderer.invoke('story:google-connect'),
    googleSetup: () => ipcRenderer.invoke('story:google-setup'),
    googleDisconnect: () => ipcRenderer.invoke('story:google-disconnect'),
    googleSheets: (pageToken) => ipcRenderer.invoke('story:google-sheets', pageToken),
    sheetTabs: (id) => ipcRenderer.invoke('story:sheet-tabs', id),
    chooseSheet: (input) => ipcRenderer.invoke('story:choose-sheet', input),
    selectedSheet: () => ipcRenderer.invoke('story:selected-sheet'),
    readSheet: () => ipcRenderer.invoke('story:read-sheet'),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('story:progress', listener);
        return () => ipcRenderer.removeListener('story:progress', listener);
    },
});

// Story and Animations share one durable, project-scoped production surface.
contextBridge.exposeInMainWorld('creative', {
    isElectron: true,
    pickRoot: () => ipcRenderer.invoke('creative:pick-root'),
    create: (opts) => ipcRenderer.invoke('creative:create', opts),
    open: (dir) => ipcRenderer.invoke('creative:open', dir),
    recent: () => ipcRenderer.invoke('creative:recent'),
    saveTrackerTemplate: () => ipcRenderer.invoke('creative:save-tracker-template'),
    voiceboxStatus: () => ipcRenderer.invoke('creative:voicebox-status'),
    get: (dir) => ipcRenderer.invoke('creative:get', dir),
    save: (dir, brief) => ipcRenderer.invoke('creative:save', dir, brief),
    start: (dir, opts) => ipcRenderer.invoke('creative:start', dir, opts),
    importFlowImages: (dir) => ipcRenderer.invoke('creative:import-flow-images', dir),
    cancel: (dir) => ipcRenderer.invoke('creative:cancel', dir),
    reveal: (dir) => ipcRenderer.invoke('creative:reveal', dir),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('creative:progress', listener);
        return () => ipcRenderer.removeListener('creative:progress', listener);
    },
});

// Local-first channel strategy and durable video queue.
contextBridge.exposeInMainWorld('channels', {
    isElectron: true,
    pickRoot: () => ipcRenderer.invoke('channels:pick-root'),
    create: (opts) => ipcRenderer.invoke('channels:create', opts),
    recent: () => ipcRenderer.invoke('channels:recent'),
    get: (dir) => ipcRenderer.invoke('channels:get', dir),
    update: (dir, patch) => ipcRenderer.invoke('channels:update', dir, patch),
    addVideo: (dir, input) => ipcRenderer.invoke('channels:add-video', dir, input),
    updateVideo: (dir, videoId, patch) => ipcRenderer.invoke('channels:update-video', dir, videoId, patch),
    archiveVideo: (dir, videoId) => ipcRenderer.invoke('channels:archive-video', dir, videoId),
    claimVideo: (dir, videoId, options) => ipcRenderer.invoke('channels:claim-video', dir, videoId, options),
    claimNext: (dir, options) => ipcRenderer.invoke('channels:claim-next', dir, options),
    releaseClaim: (dir, videoId) => ipcRenderer.invoke('channels:release-claim', dir, videoId),
    prepareBrief: (dir, videoId) => ipcRenderer.invoke('channels:prepare-brief', dir, videoId),
    openInCreative: (dir, videoId) => ipcRenderer.invoke('channels:open-in-creative', dir, videoId),
    linkProduction: (dir, videoId, projectId) => ipcRenderer.invoke('channels:link-production', dir, videoId, projectId),
    analyzeYouTube: (input) => ipcRenderer.invoke('channels:analyze-youtube', input),
    plan: (dir, input) => ipcRenderer.invoke('channels:plan', dir, input),
    addPlanned: (dir, items) => ipcRenderer.invoke('channels:add-planned', dir, items),
    googleAccount: () => ipcRenderer.invoke('story:google-account'),
    googleConnect: () => ipcRenderer.invoke('story:google-connect'),
    googleSetup: () => ipcRenderer.invoke('story:google-setup'),
    trackerCreate: (dir, options) => ipcRenderer.invoke('channels:tracker-create', dir, options),
    trackerPull: (dir) => ipcRenderer.invoke('channels:tracker-pull', dir),
    trackerPush: (dir) => ipcRenderer.invoke('channels:tracker-push', dir),
    analyticsAccount: () => ipcRenderer.invoke('channels:analytics-account'),
    analyticsSetup: () => ipcRenderer.invoke('channels:analytics-setup'),
    analyticsConnect: () => ipcRenderer.invoke('channels:analytics-connect'),
    analyticsReport: (input) => ipcRenderer.invoke('channels:analytics-report', input),
    reveal: (dir) => ipcRenderer.invoke('channels:reveal', dir),
});

contextBridge.exposeInMainWorld('entitlement', {
    isElectron: true,
    status: () => ipcRenderer.invoke('entitlement:status'),
    refresh: () => ipcRenderer.invoke('entitlement:refresh'),
});

// ── Repurpose Studio bridge (durable local Python worker jobs) ──────────────
contextBridge.exposeInMainWorld('repurpose', {
    isElectron: true,
    pickSource: () => ipcRenderer.invoke('repurpose:pick-source'),
    pickProjectDir: () => ipcRenderer.invoke('repurpose:pick-project-dir'),
    create: (opts) => ipcRenderer.invoke('repurpose:create', opts),
    get: (dir) => ipcRenderer.invoke('repurpose:get', dir),
    runStage: (dir, stage, opts) => ipcRenderer.invoke('repurpose:run-stage', dir, stage, opts),
    resumeJob: (jobId) => ipcRenderer.invoke('repurpose:resume-job', jobId),
    cancelJob: (jobId) => ipcRenderer.invoke('repurpose:cancel-job', jobId),
    getJob: (jobId) => ipcRenderer.invoke('repurpose:get-job', jobId),
    listJobs: (opts) => ipcRenderer.invoke('repurpose:list-jobs', opts),
    setCandidateDecision: (dir, candidateId, decision) => ipcRenderer.invoke('repurpose:set-candidate-decision', dir, candidateId, decision),
    selectCandidate: (dir, candidateId, selected) => ipcRenderer.invoke('repurpose:select-candidate', dir, candidateId, selected),
    readArtifact: (dir, relativePath) => ipcRenderer.invoke('repurpose:read-artifact', dir, relativePath),
    readMedia: (dir, relativePath) => ipcRenderer.invoke('repurpose:read-media', dir, relativePath),
    reveal: (dir, relativePath) => ipcRenderer.invoke('repurpose:reveal', dir, relativePath),
    getConfig: () => ipcRenderer.invoke('repurpose:get-config'),
    setConfig: (update) => ipcRenderer.invoke('repurpose:set-config', update),
    readiness: () => ipcRenderer.invoke('repurpose:readiness'),
    setupModel: () => ipcRenderer.invoke('repurpose:setup-model'),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('repurpose:progress', listener);
        return () => ipcRenderer.removeListener('repurpose:progress', listener);
    },
});

// ── Translate Video bridge (local dubbing: transcription → translation → voice → render) ──
contextBridge.exposeInMainWorld('translate', {
    isElectron: true,
    capabilities: () => ipcRenderer.invoke('translate:capabilities'),
    pickSource: () => ipcRenderer.invoke('translate:pick-source'),
    start: (payload) => ipcRenderer.invoke('translate:start', payload),
    getJob: (jobId) => ipcRenderer.invoke('translate:get-job', jobId),
    listJobs: (options) => ipcRenderer.invoke('translate:list-jobs', options),
    cancelJob: (jobId) => ipcRenderer.invoke('translate:cancel-job', jobId),
    retryJob: (jobId) => ipcRenderer.invoke('translate:retry-job', jobId),
    readArtifact: (jobId, artifact) => ipcRenderer.invoke('translate:read-artifact', jobId, artifact),
    readMedia: (jobId, artifact) => ipcRenderer.invoke('translate:read-media', jobId, artifact),
    reveal: (jobId, artifact) => ipcRenderer.invoke('translate:reveal', jobId, artifact),
    getConfig: () => ipcRenderer.invoke('translate:get-config'),
    setConfig: (update) => ipcRenderer.invoke('translate:set-config', update),
    voiceProfiles: () => ipcRenderer.invoke('translate:voice-profiles'),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('translate:progress', listener);
        return () => ipcRenderer.removeListener('translate:progress', listener);
    },
});

// Cleaner intake bridge. It records the user's edit decisions without exposing
// file-system or credential access to the renderer.
contextBridge.exposeInMainWorld('cleaner', {
    isElectron: true,
    pickSource: () => ipcRenderer.invoke('cleaner:pick-source'),
    pickOutput: () => ipcRenderer.invoke('cleaner:pick-output'),
    pickProject: () => ipcRenderer.invoke('cleaner:pick-project'),
    readiness: () => ipcRenderer.invoke('cleaner:readiness'),
    create: (setup) => ipcRenderer.invoke('cleaner:create', setup),
    get: (dir) => ipcRenderer.invoke('cleaner:get', dir),
    review: (dir, options) => ipcRenderer.invoke('cleaner:review', dir, options),
    waveform: (dir) => ipcRenderer.invoke('cleaner:waveform', dir),
    setProvider: (dir, providerId) => ipcRenderer.invoke('cleaner:set-provider', dir, providerId),
    analyze: (dir) => ipcRenderer.invoke('cleaner:analyze', dir),
    setDecision: (dir, segmentId, decision) => ipcRenderer.invoke('cleaner:set-decision', dir, segmentId, decision),
    setBoundary: (dir, segmentId, seconds, expectedSeconds) => ipcRenderer.invoke('cleaner:set-boundary', dir, segmentId, seconds, expectedSeconds),
    render: (dir) => ipcRenderer.invoke('cleaner:render', dir),
    reveal: (dir) => ipcRenderer.invoke('cleaner:reveal', dir),
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('cleaner:progress', listener);
        return () => ipcRenderer.removeListener('cleaner:progress', listener);
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
    installMcp: (agentId, serverId) => ipcRenderer.invoke('agents:installMcp', agentId, serverId),
    getLaunchConfig: () => ipcRenderer.invoke('agents:getLaunchConfig'),
    setLaunchConfig: (cfg) => ipcRenderer.invoke('agents:setLaunchConfig', cfg),
    setPreferred: (agentId) => ipcRenderer.invoke('agents:setPreferred', agentId),
    openExternal: (url) => ipcRenderer.invoke('agents:openExternal', url),
});

// VFX section bridge: no shell or key access in the renderer.
contextBridge.exposeInMainWorld('vfx', {
    isElectron: true,
    pickSource: () => ipcRenderer.invoke('vfx:pick-source'),
    dropSource: (file) => ipcRenderer.invoke('vfx:drop-source', webUtils.getPathForFile(file)),
    pickOutput: () => ipcRenderer.invoke('vfx:pick-output'),
    pickProject: () => ipcRenderer.invoke('vfx:pick-project'),
    readiness: () => ipcRenderer.invoke('vfx:readiness'),
    boards: () => ipcRenderer.invoke('vfx:boards'),
    setup: () => ipcRenderer.invoke('vfx:setup'),
    create: (payload) => ipcRenderer.invoke('vfx:create', payload),
    get: (dir) => ipcRenderer.invoke('vfx:get', dir),
    prepare: (dir) => ipcRenderer.invoke('vfx:prepare', dir),
    saveShots: (dir, shots) => ipcRenderer.invoke('vfx:save-shots', dir, shots),
    plan: (dir, revision) => ipcRenderer.invoke('vfx:plan', dir, revision),
    saveSpec: (dir, spec) => ipcRenderer.invoke('vfx:save-spec', dir, spec),
    storyboard: (dir) => ipcRenderer.invoke('vfx:storyboard', dir),
    setProvider: (dir, settings) => ipcRenderer.invoke('vfx:set-provider', dir, settings),
    render: (dir) => ipcRenderer.invoke('vfx:render', dir),
    accept: (dir) => ipcRenderer.invoke('vfx:accept', dir),
    reveal: (dir) => ipcRenderer.invoke('vfx:reveal', dir),
    cancel: (dir) => ipcRenderer.invoke('vfx:cancel', dir),
    onProgress: callback => {const listener = (_, data) => callback(data); ipcRenderer.on('vfx:progress', listener); return () => ipcRenderer.removeListener('vfx:progress', listener);},
});

// ── AI Auto-Editor Bridge (EDG, Undo/Redo, B-roll, Retention, NLE) ─────────
contextBridge.exposeInMainWorld('autoEditor', {
    isElectron: true,
    getEdg: (projectDir) => ipcRenderer.invoke('autoEditor:get-edg', projectDir),
    applyAction: (projectDir, action) => ipcRenderer.invoke('autoEditor:apply-action', projectDir, action),
    undo: (projectDir) => ipcRenderer.invoke('autoEditor:undo', projectDir),
    redo: (projectDir) => ipcRenderer.invoke('autoEditor:redo', projectDir),
    getSuggestions: (projectDir, options) => ipcRenderer.invoke('autoEditor:get-suggestions', projectDir, options),
    applyBrollSuggestion: (projectDir, opts) => ipcRenderer.invoke('autoEditor:apply-broll-suggestion', projectDir, opts),
    exportNle: (projectDir, format) => ipcRenderer.invoke('autoEditor:export-nle', projectDir, format),
    renderPreview: (projectDir, options) => ipcRenderer.invoke('autoEditor:render-preview', projectDir, options),
    cancelPreview: (jobId, projectDir) => ipcRenderer.invoke('autoEditor:cancel-preview', jobId, projectDir),
});

// ── Auto-Publisher Bridge (YouTube Data API v3 Resumable Upload & OAuth) ───
contextBridge.exposeInMainWorld('publisher', {
    isElectron: true,
    getStatus: (publishId) => ipcRenderer.invoke('publisher:get-status', publishId),
    createSession: (opts) => ipcRenderer.invoke('publisher:create-session', opts),
    testMockUpload: (opts) => ipcRenderer.invoke('publisher:test-mock-upload', opts),
    listQueue: (filter) => ipcRenderer.invoke('publisher:list-queue', filter),
    poll: (publishId) => ipcRenderer.invoke('publisher:poll', publishId),
    cancel: (publishId) => ipcRenderer.invoke('publisher:cancel', publishId),
    retry: (publishId) => ipcRenderer.invoke('publisher:retry', publishId),
});

// ── Promo & UGC Review Studio Bridge (SSRF crawler, claim checks, 3 formats EDG, renderer) ───
contextBridge.exposeInMainWorld('promo', {
    isElectron: true,
    loadFixtures: () => ipcRenderer.invoke('promo:load-fixtures'),
    safeFetch: (url) => ipcRenderer.invoke('promo:safe-fetch', url),
    classifyIntent: (metadata, override) => ipcRenderer.invoke('promo:classify-intent', metadata, override),
    verifyClaims: (claims) => ipcRenderer.invoke('promo:verify-claims', claims),
    generatePromoScript: (params) => ipcRenderer.invoke('promo:generate-promo-script', params),
    generateUgcScript: (type, params) => ipcRenderer.invoke('promo:generate-ugc-script', type, params),
    buildEdg: (opts) => ipcRenderer.invoke('promo:build-edg', opts),
    renderExport: (opts) => ipcRenderer.invoke('promo:render-export', opts),
    cancelRenderExport: (jobId) => ipcRenderer.invoke('promo:cancel-render-export', jobId),
    generateCartoonEdg: (opts) => ipcRenderer.invoke('promo:generate-cartoon-edg', opts),
    renderCartoonExport: (opts) => ipcRenderer.invoke('promo:render-cartoon-export', opts),
    generate2dMascot: (opts) => ipcRenderer.invoke('promo:generate-2d-mascot', opts),
    render2dMascot: (opts) => ipcRenderer.invoke('promo:render-2d-mascot', opts),
    cancel2dMascot: (jobId) => ipcRenderer.invoke('promo:cancel-2d-mascot', jobId),
    pickAudio: () => ipcRenderer.invoke('promo:pick-audio'),
    ffmpegCapabilities: () => ipcRenderer.invoke('promo:ffmpeg-capabilities'),
    generateScreenSession: (opts) => ipcRenderer.invoke('promo:generate-screen-session', opts),
    checkScreenRecordingPermission: () => ipcRenderer.invoke('promo:check-screen-recording-permission'),
    listScreenCaptureDevices: () => ipcRenderer.invoke('promo:list-screen-capture-devices'),
    listNativeSources: (opts) => ipcRenderer.invoke('promo:list-native-sources', opts),
    startNativeCapture: (opts) => ipcRenderer.invoke('promo:start-native-capture', opts),
    stopNativeCapture: (opts) => ipcRenderer.invoke('promo:stop-native-capture', opts),
    buildScreenStudioEdg: (opts) => ipcRenderer.invoke('promo:build-screen-studio-edg', opts),
    renderScreenStudioExport: (opts) => ipcRenderer.invoke('promo:render-screen-studio-export', opts),
    integrateCartoonStory: (opts) => ipcRenderer.invoke('promo:integrate-cartoon-story', opts),
});

// ── Screen Studio Desktop Bridge (Governed capture, telemetry, auto-zoom, export) ───
contextBridge.exposeInMainWorld('screenStudio', {
    isElectron: true,
    checkPermission: () => ipcRenderer.invoke('screen:check-permission'),
    openPermissionSettings: () => ipcRenderer.invoke('screen:open-permission-settings'),
    listSources: () => ipcRenderer.invoke('screen:list-sources'),
    status: () => ipcRenderer.invoke('screen:status'),
    startRecording: (opts) => ipcRenderer.invoke('screen:start-recording', opts),
    stopRecording: (opts) => ipcRenderer.invoke('screen:stop-recording', opts),
    cancelRecording: (opts) => ipcRenderer.invoke('screen:cancel-recording', opts),
    readRecording: (opts) => ipcRenderer.invoke('screen:read-recording', opts),
    buildPreview: (opts) => ipcRenderer.invoke('screen:build-preview', opts),
    buildEdg: (opts) => ipcRenderer.invoke('screen:build-edg', opts),
    renderExport: (opts) => ipcRenderer.invoke('screen:render-export', opts),
    cancelExport: (jobId) => ipcRenderer.invoke('screen:cancel-export', jobId),
    showInFinder: (filePath) => ipcRenderer.invoke('screen:show-in-finder', { filePath }),
});

// ── Engines & Models Bridge (Kokoro TTS, Whisper ASR model package status) ───
contextBridge.exposeInMainWorld('engines', {
    isElectron: true,
    modelPackagesStatus: () => ipcRenderer.invoke('engines:model-packages-status'),
    modelPackageVerify: (name) => ipcRenderer.invoke('engines:model-package-verify', { name }),
    hyperframesStatus: () => ipcRenderer.invoke('engines:hyperframes-status'),
});



