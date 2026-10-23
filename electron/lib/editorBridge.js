// Editor desktop bridge — narrow IPC over the pure @vidmyo/core service.
//
// The renderer never touches the pipeline, the filesystem or a model: it picks
// folders, creates a job, subscribes to progress and reads back bounded
// project-relative artifacts. The same `runEditorJob` the MCP tools call runs
// here in the main process, so an edit started from the Editor tab and one
// started by an agent are the same job in the same store.
//
// Path policy: a file the renderer hands us (music bed, example video) must have
// come from this window's picker — the grant is recorded below. Folders are the
// capability's primary input ("edit my footage located in folder XYZ"), so a typed
// absolute folder is accepted after checking it really is a readable directory;
// nothing else in the renderer can reach arbitrary paths.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { resolveRuntimePaths } = require('./runtimePaths');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mpg', 'mpeg', 'ts'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff', 'aif'];
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const fail = err => ({ ok: false, error: String((err && err.message) || err).slice(0, 1000) });

let editorServicePromise = null;

function defaultEditorService() {
  if (!editorServicePromise) {
    editorServicePromise = (async () => {
      const runtime = resolveRuntimePaths({
        isPackaged: require('electron').app?.isPackaged,
        resourcesPath: process.resourcesPath,
      });
      const { createEditorMcpService } = await import(
        pathToFileURL(path.join(runtime.mcpDir, 'lib', 'editorService.js')).href
      );
      return createEditorMcpService({});
    })();
  }
  return editorServicePromise;
}

function createEditorBridge({
  ipcMain, dialog, shell, BrowserWindow, app, serviceFactory = defaultEditorService,
} = {}) {
  if (!ipcMain || !dialog || !shell || !BrowserWindow || !app) {
    throw new Error('Editor bridge requires Electron IPC, dialog, shell, BrowserWindow, and app');
  }
  let servicePromise = null;
  let registered = false;
  const fileGrants = new Set();
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
      try { win.webContents.send('editor:progress', payload); } catch { /* window may be closing */ }
    }
  };

  const watchJob = (svc, jobId, { analysis = false } = {}) => {
    if (!jobId || activeTimers.has(jobId)) return;
    const timer = setInterval(async () => {
      try {
        const current = analysis ? svc.getAnalysis(jobId) : svc.get(jobId);
        if (!current) return;
        send({
          job_id: jobId,
          analysis,
          event: 'tick',
          stage: current.stage || null,
          state: current.state,
          progress: current.progress ?? 0,
          error: current.error || null,
        });
        if (['done', 'error', 'cancelled'].includes(current.state)) stopTimer(jobId);
      } catch { stopTimer(jobId); }
    }, 1000);
    timer.unref?.();
    activeTimers.set(jobId, timer);
  };

  function assertFolder(candidate, label, { create = false } = {}) {
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} is required`);
    if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
    const resolved = path.resolve(candidate);
    if (create) {
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    }
    if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a folder`);
    return resolved;
  }

  function assertGrantedFile(candidate, label, extensions) {
    const resolved = path.resolve(String(candidate || ''));
    if (!fileGrants.has(resolved)) throw new Error(`Choose the ${label} with the file picker first`);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`That ${label} no longer exists`);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (extensions && !extensions.includes(ext)) throw new Error(`Unsupported ${label} type: ${ext || 'unknown'}`);
    return resolved;
  }

  function normalizeStartPayload(payload = {}) {
    const inputDir = assertFolder(payload.input_dir, 'Input folder');
    const stat = fs.statSync(inputDir);
    const input = stat.isDirectory() ? inputDir : assertGrantedFile(inputDir, 'input video', VIDEO_EXTENSIONS);
    const outputDir = payload.output_dir ? assertFolder(payload.output_dir, 'Output folder', { create: true }) : null;
    const options = { ...(payload.options || {}) };
    if (payload.mode) options.mode = payload.mode;
    if (payload.engine) options.engine = payload.engine;
    if (payload.template_id) options.template_id = payload.template_id;
    if (payload.quality) options.quality = payload.quality;
    if (payload.pacing) options.pacing = payload.pacing;
    if (payload.face_share !== undefined && payload.face_share !== null) options.face_share = payload.face_share;
    if (payload.music_path) options.music_path = assertGrantedFile(payload.music_path, 'music bed', AUDIO_EXTENSIONS);
    if (Array.isArray(payload.examples)) {
      options.examples = payload.examples.map(item => {
        const value = String(item || '');
        if (/^https?:\/\//i.test(value)) return value;
        return assertGrantedFile(value, 'example video', VIDEO_EXTENSIONS);
      });
    }
    return { input, output_dir: outputDir, options, template_id: payload.template_id || null };
  }

  function register() {
    if (registered) return false;
    registered = true;

    ipcMain.handle('editor:capabilities', async () => {
      try {
        const svc = await service();
        return { ok: true, capabilities: await svc.capabilities() };
      } catch (error) { return fail(error); }
    });

    // Which local agent CLIs this machine can actually run as the Editor's brain.
    // Detection only — nothing is launched and no credentials are read here.
    ipcMain.handle('editor:agents', async () => {
      try {
        const svc = await service();
        const capabilities = await svc.capabilities();
        return { ok: true, agents: capabilities.agents || [], default_brain: capabilities.brain_default || 'none' };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:pick-folder', async (_event, kind = 'input') => {
      const titles = {
        input: 'Choose the folder with your footage',
        output: 'Choose where the edit should be written',
      };
      const result = await dialog.showOpenDialog({
        title: titles[kind] || titles.input,
        properties: ['openDirectory', 'createDirectory'],
      });
      const chosen = !result.canceled ? result.filePaths[0] || null : null;
      return { ok: Boolean(chosen), path: chosen, canceled: result.canceled };
    });

    ipcMain.handle('editor:pick-file', async (_event, kind = 'music') => {
      const music = kind === 'music';
      const result = await dialog.showOpenDialog({
        title: music ? 'Choose the music bed' : 'Choose an example video',
        properties: music ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [{ name: music ? 'Audio' : 'Video', extensions: music ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS }],
      });
      if (!result.canceled) {
        for (const file of result.filePaths) fileGrants.add(path.resolve(file));
      }
      return { ok: !result.canceled, path: result.filePaths[0] || null, paths: result.filePaths || [], canceled: result.canceled };
    });

    ipcMain.handle('editor:start', async (_event, payload = {}) => {
      try {
        const svc = await service();
        const normalized = normalizeStartPayload(payload);
        const job = svc.start({
          input: normalized.input,
          output_dir: normalized.output_dir,
          template_id: normalized.template_id,
          options: normalized.options,
        });
        send({ job_id: job.job_id, event: 'queued', stage: null, state: 'queued', progress: 0 });
        watchJob(svc, job.job_id);
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:get-job', async (_event, jobId) => {
      try {
        const svc = await service();
        return { ok: true, job: svc.get(jobId) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:list-jobs', async (_event, options = {}) => {
      try {
        const svc = await service();
        return { ok: true, ...svc.list({ limit: options?.limit || 25, state: options?.state || null }) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:cancel-job', async (_event, jobId) => {
      try {
        const svc = await service();
        const job = svc.cancel(jobId);
        send({ job_id: jobId, event: 'cancelled', stage: job.stage, state: 'cancelled' });
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:retry-job', async (_event, jobId) => {
      try {
        const svc = await service();
        const job = svc.retry(jobId);
        send({ job_id: job.job_id, event: 'queued', stage: job.stage, state: 'queued' });
        watchJob(svc, job.job_id);
        return { ok: true, job };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:templates', async (_event, options = {}) => {
      try {
        const svc = await service();
        return { ok: true, ...svc.listTemplates({ engine: options?.engine || null }) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:save-template', async (_event, payload = {}) => {
      try {
        const svc = await service();
        return { ok: true, ...svc.saveTemplate({
          name: payload.name,
          analysis_job_id: payload.analysis_job_id || null,
          profile: payload.profile || null,
          examples: Array.isArray(payload.examples) ? payload.examples : [],
          engine: payload.engine || 'v1',
          notes: payload.notes || null,
        }) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:delete-template', async (_event, id) => {
      try {
        const svc = await service();
        return { ok: true, ...svc.deleteTemplate(id) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:analyze-examples', async (_event, payload = {}) => {
      try {
        const svc = await service();
        const videos = (Array.isArray(payload.videos) ? payload.videos : [])
          .map(file => assertGrantedFile(file, 'example video', VIDEO_EXTENSIONS));
        const urls = (Array.isArray(payload.urls) ? payload.urls : [])
          .map(url => String(url || '').trim())
          .filter(Boolean);
        for (const url of urls) {
          if (!/^https?:\/\//i.test(url)) throw new Error('Example URLs must start with http:// or https://');
        }
        const analysis = svc.analyzeExamples({ urls, videos, name: payload.name || 'Style' });
        send({ job_id: analysis.job_id, analysis: true, event: 'queued', state: 'queued', progress: 0 });
        watchJob(svc, analysis.job_id, { analysis: true });
        return { ok: true, analysis };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:get-analysis', async (_event, jobId) => {
      try {
        const svc = await service();
        return { ok: true, analysis: svc.getAnalysis(jobId) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('editor:read-artifact', async (_event, jobId, artifact) => {
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

    ipcMain.handle('editor:reveal', async (_event, jobId, artifact = null) => {
      try {
        const svc = await service();
        const current = svc.get(jobId);
        if (!current?.output_dir) throw new Error('That editor job has no project folder');
        const target = artifact ? path.join(current.output_dir, artifact) : current.output_dir;
        if (!fs.existsSync(target)) throw new Error('That file does not exist yet');
        shell.showItemInFolder(target);
        return { ok: true };
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

  return { register, stop, authorizeFile: file => fileGrants.add(path.resolve(file)), activeTimers };
}

let defaultBridge = null;

function register() {
  if (!defaultBridge) {
    const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
    defaultBridge = createEditorBridge({ ipcMain, dialog, shell, BrowserWindow, app });
  }
  return defaultBridge.register();
}

function stop() {
  return defaultBridge ? defaultBridge.stop() : Promise.resolve();
}

module.exports = { createEditorBridge, register, stop };
