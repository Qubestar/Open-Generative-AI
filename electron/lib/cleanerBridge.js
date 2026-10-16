// Cleaner desktop bridge — safe intake persistence for the long-form cleanup flow.

const { ipcMain: electronIpcMain, dialog: electronDialog, shell: electronShell, app: electronApp, BrowserWindow: electronBrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');
const { pathToFileURL } = require('url');
const agentsLib = require('./agents');
const { getSecret: defaultGetSecret } = require('./secrets');
const { resolveRuntimePaths } = require('./runtimePaths');
const { createCleanerMedia } = require('./cleanerMedia');

const MANIFEST_NAME = 'cleaner.json';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const SCRIPT_MODES = new Set(['exact', 'rough', 'freestyle']);
const SAVE_MODES = new Set(['downloads', 'source', 'custom']);
const PROVIDER_MODES = new Set(['agent', 'api']);
const LOCAL_PROVIDER_IDS = new Set(
  agentsLib.KNOWN_AGENTS.filter(agent => agent.repurposeName).map(agent => agent.id),
);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SEGMENT_ID = /^segment_\d{6}$/;

function agentReadinessError(agent, fallbackName) {
  const name = agent?.name || fallbackName;
  if (!agent?.installed) return `${name} is not installed`;
  if (!agent?.authed) return `${name} needs authentication`;
  if (agent.subscriptionReady === false) return `${name} is signed in, but Claude Code cannot verify its subscription`;
  return null;
}

const fail = error => ({ ok: false, error: String(error?.message || error).slice(0, 1000) });

let corePromise = null;
function defaultCore() {
  if (!corePromise) {
    const runtime = resolveRuntimePaths({ isPackaged: electronApp?.isPackaged, resourcesPath: process.resourcesPath });
    const entry = path.join(runtime.coreDir, 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* replaced or absent */ }
  }
}

function safeStem(file) {
  const cleaned = path.basename(file, path.extname(file))
    .normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Untitled recording').slice(0, 120);
}

function nextProjectDir(root, stem) {
  const base = path.join(root, `${stem} cleaner`);
  if (!fs.existsSync(base)) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base} ${number}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not create a unique Cleaner project folder');
}

function createCleanerBridge({
  ipcMain = electronIpcMain,
  dialog = electronDialog,
  shell = electronShell,
  app = electronApp,
  agents = agentsLib,
  getSecret = defaultGetSecret,
  now = () => new Date(),
  core = defaultCore,
  BrowserWindow = electronBrowserWindow,
  execFile = nodeExecFile,
  engineDir = null,
} = {}) {
  const sourceGrants = new Set();
  const outputGrants = new Set();
  const projectGrants = new Set();
  const activeProjects = new Set();
  const activeChildren = new Set();
  const media = createCleanerMedia();
  let registered = false;

  const grantSource = file => sourceGrants.add(path.resolve(file));
  const grantOutput = dir => outputGrants.add(path.resolve(dir));

  const manifestPath = projectDir => path.join(path.resolve(projectDir), MANIFEST_NAME);
  const readManifest = projectDir => JSON.parse(fs.readFileSync(manifestPath(projectDir), 'utf8'));
  const writeManifest = (projectDir, manifest) => {
    manifest.updated_at = now().toISOString();
    atomicWriteJson(manifestPath(projectDir), manifest);
  };
  const requireProject = projectDir => {
    const resolved = path.resolve(String(projectDir || ''));
    if (!projectGrants.has(resolved)) throw new Error('Cleaner project is not authorized');
    if (!fs.existsSync(manifestPath(resolved))) throw new Error('Cleaner project does not exist');
    return resolved;
  };
  const send = payload => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('cleaner:progress', payload); } catch { /* closing window */ }
    }
  };
  const runtimePaths = () => resolveRuntimePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });

  function readRepurposeConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'repurpose-config.json'), 'utf8')) || {}; }
    catch { return {}; }
  }

  function ensureFunctionalProject(projectDir, mod) {
    const manifest = readManifest(projectDir);
    if (!manifest.stages?.ingest) {
      manifest.stages = {
        setup: manifest.stages?.setup || { state: 'completed' },
        ingest: { state: 'pending' },
        transcribe: manifest.stages?.transcribe || { state: 'pending' },
        decide_cuts: manifest.stages?.decide_cuts || { state: 'pending' },
        review: manifest.stages?.review || { state: 'pending' },
        export: manifest.stages?.export || { state: 'pending' },
      };
      writeManifest(projectDir, manifest);
    }
    const repurposeManifest = path.join(projectDir, 'repurpose.json');
    if (!fs.existsSync(repurposeManifest)) {
      mod.RepurposeProject.create(projectDir, {
        source: manifest.source,
        requestedClipCount: 1,
        contentType: 'general_speech',
        targetPlatforms: ['cleaner'],
        renderDefaults: { captions: { enabled: false } },
      });
    }
    return manifest;
  }

  function runPython(args, { env = {} } = {}) {
    const runtime = runtimePaths();
    const root = engineDir || runtime.repurposeEngineDir;
    const python = process.env.VIDMYO_REPURPOSE_PYTHON || 'python3';
    return new Promise((resolve, reject) => {
      let child;
      child = execFile(python, args, {
        env: { ...process.env, ...env, PYTHONPATH: [path.join(root, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
        timeout: 60 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout = '', stderr = '') => {
        activeChildren.delete(child);
        if (error) {
          let message = String(stderr || error.message);
          for (const line of String(stdout).trim().split('\n').reverse()) {
            try { const event = JSON.parse(line); if (event.event === 'error' && event.message) { message = event.message; break; } } catch { /* non-json output */ }
          }
          reject(new Error(message.trim().slice(0, 1000)));
        } else resolve(String(stdout));
      });
      if (child?.kill) activeChildren.add(child);
      let pending = '';
      child?.stdout?.on('data', data => {
        pending += String(data);
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.event === 'progress') send({ project_dir: args[args.indexOf('--project') + 1], stage: event.phase, fraction: event.fraction, message: event.message });
          } catch { /* non-progress output */ }
        }
      });
    });
  }

  function normalize(payload, detectedAgents) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Cleaner setup must be an object');
    const source = path.resolve(String(payload.sourcePath || ''));
    if (!sourceGrants.has(source)) throw new Error('Choose this source video in Cleaner first');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile() || !VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) {
      throw new Error('Choose an existing supported local video');
    }
    const scriptMode = String(payload.scriptMode || '');
    if (!SCRIPT_MODES.has(scriptMode)) throw new Error('Choose how the recording was scripted');
    const scriptText = String(payload.scriptText || '').trim();
    if (scriptMode !== 'freestyle' && !scriptText) throw new Error('Paste the exact script or rough outline');
    if (scriptText.length > 200000) throw new Error('The supplied script is too large');
    const includeMp4 = payload.includeMp4 !== false;
    const saveMode = String(payload.saveMode || '');
    if (!SAVE_MODES.has(saveMode)) throw new Error('Choose where Cleaner should save the project');
    let outputRoot;
    if (saveMode === 'downloads') outputRoot = path.resolve(app.getPath('downloads'));
    else if (saveMode === 'source') outputRoot = path.dirname(source);
    else {
      outputRoot = path.resolve(String(payload.customOutputDir || ''));
      if (!outputGrants.has(outputRoot)) throw new Error('Choose this custom output folder in Cleaner first');
    }
    const providerMode = String(payload.providerMode || '');
    if (!PROVIDER_MODES.has(providerMode)) throw new Error('Choose an installed agent or API provider');
    const providerId = String(payload.providerId || '');
    let model = null;
    if (providerMode === 'agent') {
      if (!LOCAL_PROVIDER_IDS.has(providerId)) throw new Error('Choose a supported installed agent');
      const detected = detectedAgents.find(agent => agent.id === providerId);
      const readinessError = agentReadinessError(detected, providerId);
      if (readinessError) throw new Error(readinessError);
    } else {
      if (providerId !== 'openrouter') throw new Error('Cleaner currently supports OpenRouter for API routing');
      if (!getSecret('openrouter')) throw new Error('Add an OpenRouter API key in Settings first');
      model = String(payload.model || '').trim();
      if (!MODEL_ID.test(model)) throw new Error('Enter an explicit OpenRouter model id');
    }
    return { source, scriptMode, scriptText, includeMp4, saveMode, outputRoot, providerMode, providerId, model };
  }

  function register() {
    if (registered) return false;
    registered = true;
    ipcMain.handle('cleaner:pick-source', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose raw talking-head video', properties: ['openFile'],
        filters: [{ name: 'Video', extensions: [...VIDEO_EXTENSIONS].map(value => value.slice(1)) }],
      });
      if (!result.canceled && result.filePaths[0]) grantSource(result.filePaths[0]);
      return { ok: !result.canceled, path: result.filePaths[0] || null, canceled: result.canceled };
    });
    ipcMain.handle('cleaner:pick-output', async () => {
      const result = await dialog.showOpenDialog({
        title: 'Choose Cleaner output folder', properties: ['openDirectory', 'createDirectory'],
      });
      if (!result.canceled && result.filePaths[0]) grantOutput(result.filePaths[0]);
      return { ok: !result.canceled, path: result.filePaths[0] || null, canceled: result.canceled };
    });
    ipcMain.handle('cleaner:pick-project', async () => {
      try {
        const result = await dialog.showOpenDialog({ title: 'Open Cleaner project', properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
        const dir = path.resolve(result.filePaths[0]);
        if (!fs.existsSync(path.join(dir, MANIFEST_NAME))) throw new Error('This folder is not a Cleaner project');
        projectGrants.add(dir);
        const manifest = readManifest(dir);
        let plan = null;
        try { plan = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', 'cleaner-plan.v1.json'), 'utf8')); } catch { /* pending */ }
        return { ok: true, dir, manifest, plan };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:readiness', async () => {
      try {
        const detected = await agents.detectAll();
        return {
          ok: true,
          agents: detected.filter(agent => LOCAL_PROVIDER_IDS.has(agent.id)),
          apiProviders: [{ id: 'openrouter', name: 'OpenRouter', configured: Boolean(getSecret('openrouter')) }],
        };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:create', async (_event, payload) => {
      try {
        const detected = await agents.detectAll();
        const setup = normalize(payload, detected);
        fs.mkdirSync(setup.outputRoot, { recursive: true });
        const projectDir = nextProjectDir(setup.outputRoot, safeStem(setup.source));
        const createdAt = now().toISOString();
        const manifest = {
          id: `cleaner_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          version: 1,
          source: { type: 'local_file', uri: setup.source },
          intake: {
            script_mode: setup.scriptMode,
            script_text: setup.scriptMode === 'freestyle' ? null : setup.scriptText,
            language: 'en',
          },
          cleanup: {
            remove_retakes: true,
            remove_false_starts: true,
            remove_dead_air: true,
            remove_filler_words: false,
            pause_treatment: 'balanced',
            review_before_export: true,
          },
          delivery: {
            include_mp4: setup.includeMp4,
            save_mode: setup.saveMode,
          },
          analysis: {
            mode: setup.providerMode,
            provider: setup.providerId,
            model: setup.model,
          },
          stages: {
            setup: { state: 'completed' },
            ingest: { state: 'pending' },
            transcribe: { state: 'pending' },
            decide_cuts: { state: 'pending' },
            review: { state: 'pending' },
            export: { state: 'pending' },
          },
          created_at: createdAt,
          updated_at: createdAt,
        };
        atomicWriteJson(path.join(projectDir, MANIFEST_NAME), manifest);
        const { RepurposeProject } = await core();
        RepurposeProject.create(projectDir, {
          source: { type: 'local_file', uri: setup.source },
          requestedClipCount: 1,
          contentType: 'general_speech',
          targetPlatforms: ['cleaner'],
          renderDefaults: { captions: { enabled: false } },
        });
        projectGrants.add(path.resolve(projectDir));
        return { ok: true, dir: projectDir, manifest };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:get', async (_event, projectDir) => {
      try {
        const resolved = requireProject(projectDir);
        const manifest = readManifest(resolved);
        let plan = null;
        try { plan = JSON.parse(fs.readFileSync(path.join(resolved, 'artifacts', 'cleaner-plan.v1.json'), 'utf8')); } catch { /* pending */ }
        return { ok: true, dir: resolved, manifest, plan };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:review', async (_event, projectDir, options = {}) => {
      let resolved;
      let acquired = false;
      try {
        resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Wait for the current Cleaner operation to finish');
        activeProjects.add(resolved);
        acquired = true;
        const stdout = await runPython(['-m', 'vidmyo_repurpose.cleaner', 'review', '--project', resolved]);
        const event = stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(item => item.plan);
        if (!event?.plan) throw new Error('Could not prepare the review timeline');
        const edited = options?.edited === true;
        const previewStdout = await runPython(['-m', 'vidmyo_repurpose.cleaner', edited ? 'preview-edit' : 'preview', '--project', resolved]);
        const preview = previewStdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(item => item.preview)?.preview;
        if (!preview || path.dirname(path.resolve(preview)) !== path.join(resolved, 'artifacts')) throw new Error('Could not prepare the local playback copy');
        return { ok: true, plan: event.plan, [edited ? 'editedUrl' : 'sourceUrl']: await media.grant(preview) };
      } catch (error) { return fail(error); }
      finally { if (acquired) activeProjects.delete(resolved); }
    });
    ipcMain.handle('cleaner:waveform', async (_event, projectDir) => {
      try {
        const resolved = requireProject(projectDir);
        const stdout = await runPython(['-m', 'vidmyo_repurpose.cleaner', 'waveform', '--project', resolved]);
        const waveform = stdout.trim().split('\n').map(line => { try { return JSON.parse(line).waveform; } catch { return null; } }).find(Boolean);
        if (!waveform || !Array.isArray(waveform.peaks) || waveform.peaks.length > 2000) throw new Error('Audio waveform unavailable');
        return { ok:true, waveform };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:set-provider', async (_event, projectDir, providerId) => {
      try {
        const resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Wait for Cleaner to finish its current operation');
        const id = String(providerId || '');
        if (!LOCAL_PROVIDER_IDS.has(id)) throw new Error('Choose a supported installed agent');
        const detected = (await agents.detectAll()).find(agent => agent.id === id);
        const readinessError = agentReadinessError(detected, id);
        if (readinessError) throw new Error(readinessError);
        if (fs.existsSync(path.join(resolved, 'artifacts', 'cleaner-plan.v1.json'))) {
          throw new Error('The cleanup plan already exists; review it instead of changing its provider');
        }
        const manifest = readManifest(resolved);
        manifest.analysis = { mode: 'agent', provider: id, model: null };
        if (manifest.stages?.decide_cuts?.state === 'failed') manifest.stages.decide_cuts.state = 'pending';
        writeManifest(resolved, manifest);
        return { ok: true, dir: resolved, manifest };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:analyze', async (_event, projectDir) => {
      let resolved;
      try {
        resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Cleaner is already working on this project');
        activeProjects.add(resolved);
        const mod = await core();
        ensureFunctionalProject(resolved, mod);
        const config = readRepurposeConfig();
        const jobStore = new mod.JobStore();
        const repurpose = mod.RepurposeProject.load(resolved);
        const runtime = runtimePaths();
        const root = engineDir || runtime.repurposeEngineDir;
        for (const stage of ['ingest', 'transcribe']) {
          if (repurpose.manifest.stages[stage].state === 'completed') continue;
          const options = stage === 'transcribe' ? {
            ...(config.transcriptionModel ? { model: config.transcriptionModel } : {}),
            ...(config.modelCache ? { model_cache: config.modelCache } : {}),
          } : {};
          const manifest = readManifest(resolved);
          manifest.stages[stage].state = 'running';
          writeManifest(resolved, manifest);
          send({ project_dir: resolved, stage, fraction: 0, message: stage === 'ingest' ? 'Inspecting the source locally' : 'Transcribing locally' });
          const existing = jobStore.list({ type: mod.REPURPOSE_JOB_TYPE }).find(job =>
            path.resolve(job.params?.projectDir || '') === resolved
            && job.params?.stage === stage && ['queued', 'running'].includes(job.state));
          const job = existing || mod.createRepurposeJob(jobStore, { projectDir: resolved, stage, options });
          const result = await mod.runRepurposeJob(jobStore, job.id, {
            python: process.env.VIDMYO_REPURPOSE_PYTHON || mod.DEFAULT_REPURPOSE_PYTHON, engineDir: root,
            onEvent: event => send({ project_dir: resolved, stage, fraction: event.payload?.fraction ?? null, message: event.payload?.message || stage }),
          });
          if (result.state !== 'done') throw new Error(result.error || `${stage} failed`);
          manifest.stages[stage].state = 'completed';
          writeManifest(resolved, manifest);
        }
        const manifest = readManifest(resolved);
        manifest.stages.decide_cuts.state = 'running';
        writeManifest(resolved, manifest);
        send({ project_dir: resolved, stage: 'decide_cuts', fraction: 0, message: 'Asking the selected AI to identify clear cleanup cuts' });
        const detected = await agents.detectAll();
        const analysis = manifest.analysis;
        const env = { ...(config.modelCache ? { VIDMYO_CLEANER_MODEL_CACHE: config.modelCache } : {}) };
        if (analysis.mode === 'api') {
          const key = getSecret('openrouter');
          if (!key) throw new Error('Add an OpenRouter API key in Settings first');
          env.OPENROUTER_API_KEY = key;
        } else {
          const detectedAgent = detected.find(agent => agent.id === analysis.provider);
          const readinessError = agentReadinessError(detectedAgent, analysis.provider);
          if (readinessError) throw new Error(`${readinessError}. Choose another installed agent for this project.`);
          env.VIDMYO_AGENT_CLI = detectedAgent.path;
          env.VIDMYO_AGENT_MODEL = `configured-default:${String(detectedAgent.version || 'unknown').replace(/[^A-Za-z0-9._/-]/g, '_').slice(0, 80)}:run-${Date.now()}`;
        }
        await runPython(['-m', 'vidmyo_repurpose.cleaner', 'analyze', '--project', resolved], { env });
        manifest.stages.decide_cuts.state = 'completed';
        manifest.stages.review.state = 'running';
        manifest.stages.export.state = 'pending';
        manifest.outputs = [];
        writeManifest(resolved, manifest);
        send({ project_dir: resolved, stage: 'review', fraction: 1, message: 'Cleanup plan ready for your review' });
        const plan = JSON.parse(fs.readFileSync(path.join(resolved, 'artifacts', 'cleaner-plan.v1.json'), 'utf8'));
        return { ok: true, dir: resolved, manifest, plan };
      } catch (error) {
        if (resolved) {
          try {
            const manifest = readManifest(resolved);
            for (const stage of ['ingest', 'transcribe', 'decide_cuts']) {
              if (manifest.stages?.[stage]?.state === 'running') manifest.stages[stage].state = 'failed';
            }
            writeManifest(resolved, manifest);
          } catch { /* preserve original error */ }
        }
        return fail(error);
      } finally {
        if (resolved) activeProjects.delete(resolved);
      }
    });
    ipcMain.handle('cleaner:set-boundary', async (_event, projectDir, segmentId, seconds, expectedSeconds) => {
      try {
        const resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Wait for Cleaner to finish its current operation');
        if (!SEGMENT_ID.test(String(segmentId || ''))) throw new Error('Invalid Cleaner section');
        const planPath = path.join(resolved, 'artifacts', 'cleaner-plan.v1.json');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        require('./cleanerTiming').moveBoundary(plan, segmentId, seconds, expectedSeconds);
        atomicWriteJson(planPath, plan);
        const manifest = readManifest(resolved);
        manifest.stages.review.state = 'running';
        manifest.stages.export.state = 'pending';
        manifest.outputs = [];
        writeManifest(resolved, manifest);
        return { ok: true };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:set-decision', async (_event, projectDir, segmentId, decision) => {
      try {
        const resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Wait for Cleaner to finish its current operation');
        if (!SEGMENT_ID.test(String(segmentId || '')) || !['keep', 'cut'].includes(decision)) throw new Error('Invalid Cleaner decision');
        const planPath = path.join(resolved, 'artifacts', 'cleaner-plan.v1.json');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        const item = plan.decisions.find(entry => entry.segment_id === segmentId);
        if (!item) throw new Error('Transcript segment is not part of this Cleaner plan');
        item.decision = decision;
        item.reviewed = true;
        plan.summary.proposed_cuts = plan.decisions.filter(entry => entry.decision === 'cut').length;
        atomicWriteJson(planPath, plan);
        const manifest = readManifest(resolved);
        manifest.stages.review.state = 'running';
        manifest.stages.export.state = 'pending';
        manifest.outputs = [];
        writeManifest(resolved, manifest);
        return { ok: true, plan };
      } catch (error) { return fail(error); }
    });
    ipcMain.handle('cleaner:render', async (_event, projectDir) => {
      let resolved;
      try {
        resolved = requireProject(projectDir);
        if (activeProjects.has(resolved)) throw new Error('Cleaner is already working on this project');
        activeProjects.add(resolved);
        const manifest = readManifest(resolved);
        if (manifest.stages.review.state !== 'running' && manifest.stages.review.state !== 'completed') throw new Error('Review the cleanup plan before export');
        manifest.stages.review.state = 'completed';
        manifest.stages.export.state = 'running';
        writeManifest(resolved, manifest);
        send({ project_dir: resolved, stage: 'export', fraction: 0, message: 'Rendering the approved cleanup locally' });
        const stdout = await runPython(['-m', 'vidmyo_repurpose.cleaner', 'render', '--project', resolved]);
        let output = 'exports/cleaned-video.mp4';
        for (const line of stdout.trim().split('\n').reverse()) {
          try { const event = JSON.parse(line); if (event.output) { output = event.output; break; } } catch { /* ignore */ }
        }
        manifest.stages.export.state = 'completed';
        manifest.outputs = [output];
        writeManifest(resolved, manifest);
        send({ project_dir: resolved, stage: 'export', fraction: 1, message: 'Cleaned video ready' });
        return { ok: true, dir: resolved, manifest, output };
      } catch (error) {
        if (resolved) try { const manifest = readManifest(resolved); if (manifest.stages.export.state === 'running') manifest.stages.export.state = 'failed'; writeManifest(resolved, manifest); } catch { /* preserve original */ }
        return fail(error);
      } finally { if (resolved) activeProjects.delete(resolved); }
    });
    ipcMain.handle('cleaner:reveal', async (_event, projectDir) => {
      try {
        const resolved = requireProject(projectDir);
        const file = path.join(resolved, MANIFEST_NAME);
        if (!fs.existsSync(file)) throw new Error('Cleaner project does not exist');
        shell.showItemInFolder(file);
        return { ok: true };
      } catch (error) { return fail(error); }
    });
    return true;
  }

  async function stop() {
    media.close();
    for (const child of activeChildren) {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    }
    activeChildren.clear();
  }

  return { register, stop, grantSource, grantOutput };
}

let defaultBridge = null;
function register() {
  if (!defaultBridge) defaultBridge = createCleanerBridge();
  return defaultBridge.register();
}

function stop() {
  return defaultBridge?.stop() || Promise.resolve();
}

module.exports = { MANIFEST_NAME, createCleanerBridge, register, stop };
