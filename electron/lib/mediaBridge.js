// Cloud media bridge — generic image/video generation for the studio tabs.
// Runs @vidmyo/core (JobStore + runJob + falAdapter) in the Electron main
// process with the fal key from the OS keychain; the renderer talks through
// the narrow media:* IPC surface. Artifacts land in the Vidmyo artifact store
// (default `~/.vidmyo/artifacts`, `VIDMYO_HOME`-overridable) and job records
// in the shared jobs store — the same stores the CLI/MCP will read.
//
// Phase 3 (item 1): every directory is injectable. Production keeps the
// historical defaults; tests pass a private mkdtemp directory so no bridge
// test can read or write the real ~/.vidmyo.

const { ipcMain, shell, dialog, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { getSecret } = require('./secrets');
const { vidmyoHome } = require('../../packages/core/src/paths.cjs');

let corePromise = null;
function defaultCore() {
  if (!corePromise) {
    const entry = path.join(__dirname, '..', '..', 'packages', 'core', 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

// Resolution order (Phase 3 item 1): explicit dep -> app.getPath('userData')
// -> vidmyoHome(). Production keeps app.getPath('userData').
function resolveUserDataDir(deps) {
  if (deps.userDataDir) return path.resolve(deps.userDataDir);
  const app = deps.app;
  try {
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {
    // fall through to vidmyoHome()
  }
  return vidmyoHome();
}

function createMediaBridge(deps = {}) {
  const ipc = deps.ipcMain || ipcMain;
  const windows = deps.BrowserWindow || BrowserWindow;
  const dialogs = deps.dialog || dialog;
  const systemShell = deps.shell || shell;
  const getCore = deps.core || defaultCore;

  const userDataDir = resolveUserDataDir(deps);
  const artifactsDir = deps.artifactsDir ? path.resolve(deps.artifactsDir) : path.join(userDataDir, 'artifacts');
  const jobsDir = deps.jobsDir ? path.resolve(deps.jobsDir) : path.join(userDataDir, 'jobs');
  const exportsDir = deps.exportsDir ? path.resolve(deps.exportsDir) : path.join(userDataDir, 'exports');

  const activeJobs = new Set();
  let authorizationStore = null;
  const injectedGovernorDir = deps.governorDir ? path.resolve(deps.governorDir) : null;
  const govDir = (mod) => injectedGovernorDir || mod.defaultGovernorDir();
  const openStore = (mod) => new mod.JobStore(jobsDir, { governorDir: govDir(mod) });

  // Only files inside the Vidmyo artifact store may be read back or revealed.
  function insideArtifacts(p) {
    const resolved = path.resolve(p);
    return resolved === artifactsDir || resolved.startsWith(artifactsDir + path.sep);
  }

  function sendProgress(payload) {
    if (!windows || typeof windows.getAllWindows !== 'function') return;
    for (const win of windows.getAllWindows()) {
      win.webContents.send('media:progress', payload);
    }
  }

  async function adapterFor(mod, { provider, model, kind }) {
    const key = getSecret(provider);
    if (!key) throw new Error(`No ${provider === 'agnes' ? 'Agnes AI' : 'fal.ai'} key saved — add it in Settings first.`);
    return mod.makeGenerationAdapter(provider, { key, model, kind });
  }

  async function executeStoredJob(mod, store, job) {
    if (activeJobs.has(job.id)) return fail(new Error('This generation is already running in Vidmyo.'));
    const model = job.checkpoints?.model;
    const adapter = await adapterFor(mod, { provider: job.provider, model, kind: job.type });
    activeJobs.add(job.id);
    sendProgress({ jobId: job.id, phase: 'start', model, resumed: Boolean(job.checkpoints?.handle) });
    try {
      const pollMs = adapter.pollMs || (job.type === 'video' ? 4000 : 1500);
      const done = await mod.runJob(store, job.id, adapter, {
        outDir: artifactsDir,
        pollMs,
        maxPolls: Math.ceil((job.type === 'video' ? 1600000 : 300000) / pollMs),
      });
      if (done.state === 'cancelled') {
        sendProgress({ jobId: job.id, phase: 'cancelled' });
        return { ok: false, canceled: true, jobId: job.id };
      }
      if (done.state !== 'done') {
        sendProgress({ jobId: job.id, phase: 'error', message: done.error });
        return fail(new Error(done.error || `job ended in state ${done.state}`));
      }
      sendProgress({ jobId: job.id, phase: 'done' });
      const artifact = done.artifacts[0].path;
      const ext = path.extname(artifact).toLowerCase();
      const out = { ok: true, jobId: done.id, path: artifact, mime: MIME[ext] || 'application/octet-stream' };
      if (job.type === 'image') out.dataUrl = `data:${out.mime};base64,${fs.readFileSync(artifact).toString('base64')}`;
      return out;
    } finally {
      activeJobs.delete(job.id);
    }
  }

  function register() {
    ipc.handle('media:authorize-generation', async (_evt, request = {}) => {
      try {
        const mod = await getCore();
        authorizationStore ||= new mod.GenerationAuthorizationStore();
        return { ok: true, ...authorizationStore.issue(request) };
      } catch (err) { return fail(err); }
    });

    ipc.handle('media:generate', async (_evt, { authorizationId, kind = 'image', provider = 'fal', model, params = {} } = {}) => {
      try {
        if (!['image', 'video'].includes(kind)) return fail(new Error('unsupported media generation kind'));
        if (!['fal', 'agnes'].includes(provider)) return fail(new Error('unsupported media generation provider'));
        if (!model) return fail(new Error('model endpoint id is required'));
        const mod = await getCore();
        authorizationStore ||= new mod.GenerationAuthorizationStore();
        authorizationStore.consume(authorizationId, { kind, provider, model, params });
        const store = openStore(mod);
        const job = store.create({ type: kind, provider, params });
        store.checkpoint(job.id, 'model', model);
        return executeStoredJob(mod, store, store.get(job.id));
      } catch (err) {
        return fail(err);
      }
    });

    ipc.handle('media:list-jobs', async (_evt, { type = null, limit = 12 } = {}) => {
      try {
        const mod = await getCore();
        const store = openStore(mod);
        const jobs = store.list({ type }).filter(job => ['queued', 'running', 'error'].includes(job.state)).map(job => {
          const readiness = mod.generationResumeReadiness(job);
          return { id: job.id, type: job.type, provider: job.provider, state: job.state, model: job.checkpoints?.model || '', createdAt: job.createdAt, safeToResume: readiness.safe, reason: readiness.reason, active: activeJobs.has(job.id) };
        }).filter(job => job.state !== 'error' || job.safeToResume).slice(0, limit);
        return { ok: true, jobs };
      } catch (err) { return fail(err); }
    });

    ipc.handle('media:cancel-job', async (_evt, jobId) => {
      try {
        const mod = await getCore();
        const store = openStore(mod);
        const job = store.get(jobId);
        if (!job || !['image', 'video'].includes(job.type)) return fail(new Error('Generation job not found.'));
        if (!['queued', 'running'].includes(job.state)) return fail(new Error(`This ${job.state} job cannot be cancelled.`));
        store.cancel(jobId);
        sendProgress({ jobId, phase: 'cancelled' });
        return { ok: true, jobId };
      } catch (err) { return fail(err); }
    });

    ipc.handle('media:resume-job', async (_evt, jobId) => {
      try {
        const mod = await getCore();
        const store = openStore(mod);
        const job = store.get(jobId);
        const readiness = mod.generationResumeReadiness(job);
        if (!readiness.safe) return fail(new Error(readiness.reason));
        if (job.state === 'error') store.resume(jobId);
        return executeStoredJob(mod, store, job);
      } catch (err) { return fail(err); }
    });

    // Read an artifact back as bytes (video playback via blob URL).
    ipc.handle('media:read-file', async (_evt, p) => {
      try {
        if (!insideArtifacts(p)) return fail(new Error('path outside the artifact store'));
        const ext = path.extname(p).toLowerCase();
        return { ok: true, bytes: new Uint8Array(fs.readFileSync(p)), mime: MIME[ext] || 'application/octet-stream' };
      } catch (err) {
        return fail(err);
      }
    });

    ipc.handle('media:recent', async (_evt, { type = null, limit = 12 } = {}) => {
      try {
        const mod = await getCore();
        const store = openStore(mod);
        const jobs = store.list({ state: 'done', type }).slice(0, limit).map((j) => ({
          id: j.id,
          type: j.type,
          prompt: j.params?.prompt || '',
          artifact: j.artifacts?.[0]?.path || null,
          endedAt: j.endedAt,
        }));
        return { ok: true, jobs };
      } catch (err) {
        return fail(err);
      }
    });

    // Native file picker for "animate an image" — the user explicitly chooses a
    // file via the system dialog, so reading it isn't bound by insideArtifacts().
    ipc.handle('media:pick-image', async () => {
      try {
        const win = windows && typeof windows.getFocusedWindow === 'function' ? windows.getFocusedWindow() : null;
        const res = await dialogs.showOpenDialog(win, {
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        });
        if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
        const p = res.filePaths[0];
        const ext = path.extname(p).toLowerCase();
        const dataUrl = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(p).toString('base64')}`;
        return { ok: true, path: p, dataUrl };
      } catch (err) {
        return fail(err);
      }
    });

    ipc.handle('media:reveal', async (_evt, p) => {
      try {
        if (!insideArtifacts(p)) return fail(new Error('path outside the artifact store'));
        systemShell.showItemInFolder(path.resolve(p));
        return { ok: true };
      } catch (err) {
        return fail(err);
      }
    });
  }

  return { register, paths: { userDataDir, artifactsDir, jobsDir, exportsDir } };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) defaultBridge = createMediaBridge();
  return defaultBridge.register();
}

module.exports = { register, createMediaBridge };
