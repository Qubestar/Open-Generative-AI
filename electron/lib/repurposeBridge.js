// Repurpose desktop bridge — narrow IPC over the pure @vidmyo/core runner.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { getSecret: defaultGetSecret } = require('./secrets');
const { resolveRuntimePaths } = require('./runtimePaths');

let corePromise = null;
function defaultCore() {
  if (!corePromise) {
    const entry = path.join(__dirname, '..', '..', 'packages', 'core', 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MEDIA_MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};
const fail = err => ({ ok: false, error: String((err && err.message) || err).slice(0, 1000) });

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* replaced or absent */ }
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    project: job.project,
    projectDir: job.params?.projectDir || null,
    stage: job.params?.stage || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    logs: job.logs || [],
    artifacts: job.artifacts || [],
    checkpoints: job.checkpoints || {},
    error: job.error,
  };
}

function createRepurposeBridge({
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  app,
  core = defaultCore,
  getSecret = defaultGetSecret,
  execFileImpl,
  engineDir = null,
} = {}) {
  if (!ipcMain || !dialog || !shell || !BrowserWindow || !app) {
    throw new Error('Repurpose bridge requires Electron IPC, dialog, shell, BrowserWindow, and app');
  }
  const active = new Map();
  const trustedEngineDir = engineDir;
  const projectGrants = new Set();
  const sourceGrants = new Set();
  let registered = false;
  const configFile = () => path.join(app.getPath('userData'), 'repurpose-config.json');
  const normalizeConfig = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized = {};
    if (value.modelCache) {
      if (!path.isAbsolute(value.modelCache)) throw new Error('modelCache must be an absolute path');
      normalized.modelCache = path.resolve(value.modelCache);
    }
    return normalized;
  };
  const readConfig = () => {
    try { return normalizeConfig(JSON.parse(fs.readFileSync(configFile(), 'utf8'))); } catch { return {}; }
  };
  const writeConfig = update => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Repurpose config must be an object');
    const allowed = ['modelCache'];
    for (const key of Object.keys(update)) if (!allowed.includes(key)) throw new Error(`Unknown Repurpose config field: ${key}`);
    const next = { ...readConfig() };
    for (const key of allowed) {
      if (!Object.hasOwn(update, key)) continue;
      if (update[key] !== null && (typeof update[key] !== 'string' || !update[key].trim())) {
        throw new Error(`${key} must be a non-empty string or null`);
      }
      if (update[key] === null) delete next[key]; else next[key] = update[key].trim();
    }
    const normalized = normalizeConfig(next);
    atomicWriteJson(configFile(), normalized);
    return normalized;
  };

  const send = payload => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('repurpose:progress', payload); } catch { /* a window may close between list and send */ }
    }
  };

  const grantProject = projectDir => projectGrants.add(path.resolve(projectDir));
  const grantSource = sourcePath => sourceGrants.add(path.resolve(sourcePath));
  const requireProjectGrant = projectDir => {
    const resolved = path.resolve(projectDir);
    if (!projectGrants.has(resolved)) throw new Error('Choose this Repurpose project folder before accessing it');
    return resolved;
  };

  async function store() {
    const { JobStore } = await core();
    return new JobStore();
  }

  async function summarize(projectDir) {
    const mod = await core();
    const resolved = path.resolve(projectDir);
    const project = mod.RepurposeProject.load(resolved);
    const jobs = (await store()).list({ type: mod.REPURPOSE_JOB_TYPE })
      .filter(job => path.resolve(job.params?.projectDir || '') === resolved)
      .map(job => ({ ...publicJob(job), active: active.has(job.id) }));
    return { ok: true, dir: resolved, manifest: project.manifest, jobs };
  }

  function launch(jobId) {
    if (active.has(jobId)) return active.get(jobId).promise;
    const entry = { child: null, promise: null };
    active.set(jobId, entry);
    let job = null;
    entry.promise = (async () => {
      const mod = await core();
      const jobStore = await store();
      job = jobStore.get(jobId);
      if (!job || job.type !== mod.REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
      const openRouterKey = ['generate_candidates', 'rank'].includes(job.params.stage) ? getSecret('openrouter') : null;
      return mod.runRepurposeJob(jobStore, jobId, {
        python: mod.DEFAULT_REPURPOSE_PYTHON,
        engineDir: trustedEngineDir || mod.DEFAULT_REPURPOSE_ENGINE_DIR,
        extraEnv: openRouterKey ? { OPENROUTER_API_KEY: openRouterKey } : {},
        onChild: child => { entry.child = child; },
        onEvent: event => send({ ...event, state: jobStore.get(jobId)?.state || 'running' }),
      });
    })().then(result => {
      send({ job_id: jobId, event: result.state, stage: result.params.stage, state: result.state, error: result.error });
      return result;
    }).catch(error => {
      send({ job_id: jobId, event: 'error', stage: job?.params?.stage || null, state: 'error', error: String(error.message || error).slice(0, 1000) });
      throw error;
    }).finally(() => active.delete(jobId));
    return entry.promise;
  }

  async function ensureProjectIdle(projectDir) {
    const mod = await core();
    const resolved = path.resolve(projectDir);
    const busy = (await store()).list({ type: mod.REPURPOSE_JOB_TYPE })
      .some(job => ['queued', 'running'].includes(job.state)
        && path.resolve(job.params?.projectDir || '') === resolved);
    if (busy) throw new Error('Candidate decisions cannot change while a Repurpose stage is queued or running');
  }

  async function stop() {
    const mod = await core();
    const jobStore = await store();
    for (const [jobId, entry] of active.entries()) {
      try {
        mod.cancelRepurposeJob(jobStore, jobId, {
          terminate: entry.child ? () => entry.child.kill('SIGTERM') : null,
        });
      } catch { /* already terminal */ }
    }
  }

  function register() {
    if (registered) return false;
    registered = true;

    ipcMain.handle('repurpose:pick-source', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose source video', properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'] }],
      });
      if (!result.canceled && result.filePaths[0]) grantSource(result.filePaths[0]);
      return { ok: !result.canceled, path: result.filePaths[0] || null, canceled: result.canceled };
    });

    ipcMain.handle('repurpose:pick-project-dir', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose Repurpose project folder', properties: ['openDirectory', 'createDirectory'],
      });
      if (!result.canceled && result.filePaths[0]) grantProject(result.filePaths[0]);
      return { ok: !result.canceled, dir: result.filePaths[0] || null, canceled: result.canceled };
    });

    ipcMain.handle('repurpose:create', async (_event, {
      dir, sourcePath, requestedClipCount = 5, contentType = 'auto',
      targetPlatforms = ['youtube_shorts', 'tiktok', 'instagram_reels'], renderDefaults = {},
    } = {}) => {
      try {
        const source = path.resolve(sourcePath || '');
        const projectDir = requireProjectGrant(dir);
        if (!sourceGrants.has(source)) throw new Error('Choose this source video before creating the project');
        if (!sourcePath || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Choose an existing local source video');
        const { RepurposeProject } = await core();
        RepurposeProject.create(projectDir, {
          source: { type: 'local_file', uri: source },
          requestedClipCount, contentType, targetPlatforms, renderDefaults,
        });
        return await summarize(dir);
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:get', async (_event, dir) => {
      try { return await summarize(requireProjectGrant(dir)); } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:run-stage', async (_event, dir, stage, options = {}) => {
      try {
        const mod = await core();
        const jobStore = await store();
        const projectDir = requireProjectGrant(dir);
        const cfg = readConfig();
        const stageOptions = {
          ...options,
          ...(stage === 'transcribe' && cfg.modelCache && !options.model_cache ? { model_cache: cfg.modelCache } : {}),
        };
        const job = mod.createRepurposeJob(jobStore, { projectDir, stage, options: stageOptions });
        void launch(job.id).catch(() => {});
        return { ok: true, job: { ...publicJob(job), active: true } };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:resume-job', async (_event, jobId) => {
      try {
        const mod = await core();
        const jobStore = await store();
        const job = jobStore.get(jobId);
        if (!job || job.type !== mod.REPURPOSE_JOB_TYPE || job.state !== 'running') throw new Error('Only a persisted running Repurpose job can resume');
        requireProjectGrant(job.params.projectDir);
        void launch(jobId).catch(() => {});
        return { ok: true, job: publicJob(job) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:cancel-job', async (_event, jobId) => {
      try {
        const mod = await core();
        const jobStore = await store();
        const existing = jobStore.get(jobId);
        if (!existing || existing.type !== mod.REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
        requireProjectGrant(existing.params.projectDir);
        const owned = active.get(jobId)?.child || null;
        const job = mod.cancelRepurposeJob(jobStore, jobId, {
          terminate: owned ? () => owned.kill('SIGTERM') : null,
        });
        send({ job_id: jobId, event: 'cancelled', stage: job.params.stage, state: 'cancelled' });
        return { ok: true, job: publicJob(job) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:get-job', async (_event, jobId) => {
      try {
        const mod = await core();
        const job = (await store()).get(jobId);
        if (!job || job.type !== mod.REPURPOSE_JOB_TYPE) throw new Error(`No such Repurpose job: ${jobId}`);
        requireProjectGrant(job.params.projectDir);
        return { ok: true, job: publicJob(job), active: active.has(jobId) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:list-jobs', async (_event, { projectDir = null, state = null, limit = 50 } = {}) => {
      try {
        const mod = await core();
        if (!projectDir) throw new Error('Choose a Repurpose project folder before listing its jobs');
        const grantedProject = requireProjectGrant(projectDir);
        const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
        const jobs = (await store()).list({ type: mod.REPURPOSE_JOB_TYPE, state })
          .filter(job => path.resolve(job.params?.projectDir || '') === grantedProject)
          .slice(0, boundedLimit)
          .map(publicJob);
        return { ok: true, jobs };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:set-candidate-decision', async (_event, dir, candidateId, decision) => {
      try {
        await ensureProjectIdle(dir);
        const { RepurposeProject } = await core();
        const project = RepurposeProject.load(requireProjectGrant(dir));
        project.setCandidateDecision(candidateId, decision);
        return await summarize(dir);
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:select-candidate', async (_event, dir, candidateId, selected = true) => {
      try {
        await ensureProjectIdle(dir);
        const { RepurposeProject } = await core();
        const project = RepurposeProject.load(requireProjectGrant(dir));
        project.selectCandidate(candidateId, selected);
        return await summarize(dir);
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:read-artifact', async (_event, dir, relativePath) => {
      try {
        if (path.extname(relativePath).toLowerCase() !== '.json') throw new Error('Only project-owned JSON artifacts can be read');
        const { insideRepurposeProject } = await core();
        const file = insideRepurposeProject(requireProjectGrant(dir), relativePath);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('Artifact is missing or too large');
        return { ok: true, path: relativePath, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:read-media', async (_event, dir, relativePath) => {
      try {
        const extension = path.extname(relativePath).toLowerCase();
        if (!MEDIA_MIME[extension]) throw new Error('Only project-owned video previews can be read');
        const { insideRepurposeProject } = await core();
        const file = insideRepurposeProject(requireProjectGrant(dir), relativePath);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) throw new Error('Preview is missing or exceeds the 256 MiB desktop limit');
        return { ok: true, path: relativePath, bytes: new Uint8Array(await fs.promises.readFile(file)), mime: MEDIA_MIME[extension] };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:reveal', async (_event, dir, relativePath) => {
      try {
        const { insideRepurposeProject } = await core();
        const file = insideRepurposeProject(requireProjectGrant(dir), relativePath);
        if (!fs.existsSync(file)) throw new Error('Project artifact does not exist');
        shell.showItemInFolder(file);
        return { ok: true };
      } catch (error) { return fail(error); }
    });

    ipcMain.handle('repurpose:get-config', async () => ({ ok: true, config: readConfig() }));
    ipcMain.handle('repurpose:set-config', async (_event, update) => {
      try { return { ok: true, config: writeConfig(update) }; } catch (error) { return fail(error); }
    });
    ipcMain.handle('repurpose:readiness', async () => {
      try {
        const mod = await core();
        const cfg = readConfig();
        const readiness = await mod.inspectRepurposeReadiness({
          python: mod.DEFAULT_REPURPOSE_PYTHON,
          engineDir: trustedEngineDir || mod.DEFAULT_REPURPOSE_ENGINE_DIR,
          modelCache: cfg.modelCache || null,
          ...(execFileImpl ? { execFileImpl } : {}),
        });
        return { ok: true, readiness };
      } catch (error) { return fail(error); }
    });
    return true;
  }

  return {
    register, launch, summarize, stop, active, readConfig, writeConfig,
    authorizeProject: grantProject,
    authorizeSource: grantSource,
  };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) {
    const { ipcMain, dialog, shell, BrowserWindow, app } = require('electron');
    const runtime = resolveRuntimePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
    defaultBridge = createRepurposeBridge({
      ipcMain, dialog, shell, BrowserWindow, app,
      engineDir: runtime.repurposeEngineDir,
    });
  }
  return defaultBridge.register();
}

function stop() {
  return defaultBridge ? defaultBridge.stop() : Promise.resolve();
}

module.exports = { createRepurposeBridge, register, stop };
