// Translate Video desktop bridge — narrow IPC over the pure @vidmyo/core service.
//
// The renderer never touches the pipeline, the filesystem, or a model: it creates
// a job, subscribes to progress, and reads back bounded project-relative
// artifacts. The same `runTranslateJob` the MCP tools call runs here in the main
// process, so a dub started from the Translate tab and one started by an agent are
// the same job in the same store.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveRuntimePaths } = require('./runtimePaths');
const voicebox = require('./voicebox');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mpg', 'mpeg', 'ts'];
const MEDIA_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.srt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const fail = err => ({ ok: false, error: String((err && err.message) || err).slice(0, 1000) });

let translateServicePromise = null;

function defaultTranslateService() {
  if (!translateServicePromise) {
    translateServicePromise = (async () => {
      const runtime = resolveRuntimePaths({
        isPackaged: require('electron').app?.isPackaged,
        resourcesPath: process.resourcesPath,
      });
      const core = await import(pathToFileURL(path.join(runtime.coreDir, 'index.js')).href);
      const { createTranslateMcpService } = await import(
        pathToFileURL(path.join(runtime.mcpDir, 'lib', 'translateService.js')).href
      );
      const runConverter = (command, args) => new Promise((resolve, reject) => {
        execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, error => (error ? reject(error) : resolve()));
      });
      // One voicebox client for the whole app: the desktop narration path and the
      // TTS-cloning path in Translate share electron/lib/voicebox.js.
      const engines = core.createTranslateEngines({
        voiceboxNarrate: request => voicebox.createVoiceboxNarration({
          ...request,
          approved: true,
          run: request.run || runConverter,
        }),
      });
      return createTranslateMcpService({ engines });
    })();
  }
  return translateServicePromise;
}

function createTranslateBridge({ ipcMain, dialog, shell, BrowserWindow, app, serviceFactory = defaultTranslateService } = {}) {
  if (!ipcMain || !dialog || !shell || !BrowserWindow || !app) {
    throw new Error('Translate bridge requires Electron IPC, dialog, shell, BrowserWindow, and app');
  }
  let servicePromise = null;
  let registered = false;
  const sourceGrants = new Set();
  const activeTimers = new Map();
  const stopTimer = jobId => {
    const timer = activeTimers.get(jobId);
    if (timer) clearInterval(timer);
    activeTimers.delete(jobId);
  };

  const service = () => {
    if (!servicePromise) servicePromise = Promise.resolve(serviceFactory());
    return servicePromise;
  };

  const send = payload => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('translate:progress', payload); } catch { /* window may be closing */ }
    }
  };

  const grantSource = sourcePath => sourceGrants.add(path.resolve(sourcePath));
  const configFile = () => path.join(app.getPath('userData'), 'translate-config.json');

  const readConfig = () => {
    try {
      const value = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };

  const writeConfig = update => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Translate settings must be an object');
    const allowed = ['translationModel', 'transcriptionModel', 'voiceId', 'backgroundMode', 'demucsDevice'];
    for (const key of Object.keys(update)) if (!allowed.includes(key)) throw new Error(`Unknown translate setting: ${key}`);
    const next = { ...readConfig() };
    for (const key of allowed) {
      if (!Object.hasOwn(update, key)) continue;
      if (update[key] === null) { delete next[key]; continue; }
      if (typeof update[key] !== 'string' || update[key].length > 300) throw new Error(`${key} must be a short string or null`);
      next[key] = update[key].trim();
    }
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    const temporary = `${configFile()}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
    fs.renameSync(temporary, configFile());
    return next;
  };

  /** A local path is only readable when the user picked it or it is a real video. */
  function authorizeLocalPath(candidate) {
    const resolved = path.resolve(String(candidate || ''));
    if (!sourceGrants.has(resolved)) throw new Error('Choose this video with the file picker before translating it');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('That video file no longer exists');
    return resolved;
  }

  function register() {
    if (registered) return false;
    registered = true;

    ipcMain.handle('translate:capabilities', async () => {
      try {
        const svc = await service();
        return { ok: true, capabilities: await svc.capabilities() };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:pick-source', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose a video to translate',
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }],
      });
      if (!result.canceled && result.filePaths[0]) grantSource(result.filePaths[0]);
      return { ok: !result.canceled, path: result.filePaths[0] || null, canceled: result.canceled };
    });

    ipcMain.handle('translate:start', async (_event, payload = {}) => {
      try {
        const svc = await service();
        const cfg = readConfig();
        const rawInput = payload.input || {};
        let input = rawInput;
        if (rawInput && typeof rawInput === 'object' && (rawInput.type === 'file' || rawInput.type === 'media')) {
          input = { ...rawInput, uri: authorizeLocalPath(rawInput.uri) };
        } else if (typeof rawInput === 'string' && path.isAbsolute(rawInput) && !/^https?:/i.test(rawInput)) {
          input = { type: 'file', uri: authorizeLocalPath(rawInput) };
        }
        const options = {
          ...(payload.options || {}),
          ...(payload.options?.translation_model ? {} : (cfg.translationModel ? { translation_model: cfg.translationModel } : {})),
          ...(payload.options?.transcription_model ? {} : (cfg.transcriptionModel ? { transcription_model: cfg.transcriptionModel } : {})),
          ...(payload.options?.voice_id ? {} : (cfg.voiceId ? { voice_id: cfg.voiceId } : {})),
        };
        const job = svc.start({ input, options });
        send({ job_id: job.job_id, event: 'queued', stage: null, state: 'queued', progress: 0 });
        // Poll the durable record so the renderer sees stage transitions without
        // the main process holding a per-job subscription.
        if (!activeTimers.has(job.job_id)) {
          const timer = setInterval(async () => {
            try {
              const current = svc.get(job.job_id);
              if (!current) return;
              send({ job_id: current.job_id, event: 'tick', stage: current.stage, state: current.state, progress: current.progress, stage_status: current.stages?.find(entry => entry.id === current.stage)?.status || null, error: current.error });
              if (['done', 'error', 'cancelled'].includes(current.state)) stopTimer(job.job_id);
            } catch { stopTimer(job.job_id); }
          }, 1000);
          timer.unref?.();
          activeTimers.set(job.job_id, timer);
        }
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:get-job', async (_event, jobId) => {
      try {
        const svc = await service();
        return { ok: true, job: svc.get(jobId) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:list-jobs', async (_event, options = {}) => {
      try {
        const svc = await service();
        return { ok: true, ...svc.list({ limit: options?.limit || 25, state: options?.state || null }) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:cancel-job', async (_event, jobId) => {
      try {
        const svc = await service();
        const job = svc.cancel(jobId);
        send({ job_id: jobId, event: 'cancelled', stage: job.stage, state: 'cancelled' });
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:retry-job', async (_event, jobId) => {
      try {
        const svc = await service();
        const job = svc.retry(jobId);
        send({ job_id: job.job_id, event: 'queued', stage: job.stage, state: 'queued' });
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:read-artifact', async (_event, jobId, artifact) => {
      try {
        const svc = await service();
        if (path.extname(String(artifact || '')).toLowerCase() !== '.json') {
          throw new Error('Only project-owned JSON artifacts can be read here');
        }
        const result = svc.readArtifact(jobId, artifact);
        if (Buffer.byteLength(JSON.stringify(result.value)) > MAX_JSON_BYTES) throw new Error('Artifact is too large to display');
        return { ok: true, ...result };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:read-media', async (_event, jobId, artifact) => {
      try {
        const svc = await service();
        const current = svc.get(jobId);
        if (!current?.project_dir) throw new Error('That translate job has no project directory');
        const extension = path.extname(String(artifact || '')).toLowerCase();
        if (!MEDIA_MIME[extension]) throw new Error('Only translate outputs can be previewed');
        const { insideTranslateProject } = await import(
          pathToFileURL(path.join(resolveRuntimePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }).coreDir, 'index.js')).href
        );
        const file = insideTranslateProject(current.project_dir, artifact);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) throw new Error('That output is missing or exceeds the 512 MiB preview limit');
        return { ok: true, artifact, mime: MEDIA_MIME[extension], bytes: new Uint8Array(await fs.promises.readFile(file)) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:reveal', async (_event, jobId, artifact = null) => {
      try {
        const svc = await service();
        const current = svc.get(jobId);
        if (!current?.project_dir) throw new Error('That translate job has no project directory');
        const target = artifact ? path.join(current.project_dir, artifact) : current.project_dir;
        if (!fs.existsSync(target)) throw new Error('That file does not exist yet');
        shell.showItemInFolder(target);
        return { ok: true };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:get-config', async () => ({ ok: true, config: readConfig() }));
    ipcMain.handle('translate:set-config', async (_event, update) => {
      try { return { ok: true, config: writeConfig(update) }; } catch (error) { return fail(error); }
    });

    ipcMain.handle('translate:voice-profiles', async () => {
      try {
        const status = await voicebox.voiceboxStatus({});
        return { ok: true, ...status };
      } catch (error) { return fail(error); }
    });

    return true;
  }

  async function stop() {
    for (const jobId of [...activeTimers.keys()]) stopTimer(jobId);
    if (servicePromise) {
      try {
        const svc = await servicePromise;
        await svc.close();
      } catch { /* shutting down */ }
    }
  }

  return { register, stop, authorizeSource: grantSource, readConfig, writeConfig, activeTimers };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) {
    const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
    defaultBridge = createTranslateBridge({ ipcMain, dialog, shell, BrowserWindow, app });
  }
  return defaultBridge.register();
}

function stop() {
  return defaultBridge ? defaultBridge.stop() : Promise.resolve();
}

module.exports = { createTranslateBridge, register, stop };
