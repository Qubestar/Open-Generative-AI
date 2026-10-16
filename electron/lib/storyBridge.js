// Story Studio bridge — runs @vidmyo/core in the Electron main process and
// exposes a narrow story:* IPC surface to the renderer (core is Node-only:
// fs, child_process). Same pattern as secrets.js / netProxy.js.
//
// core is ESM and this file is CJS, so it's loaded once via dynamic import().
// In packaged builds packages/core ships in the asar (see package.json
// build.files) — core has zero npm dependencies.

const { ipcMain, dialog, app, BrowserWindow, safeStorage, shell } = require('electron');
const { confirmNarration } = require('./narrationConsent');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { getSecret } = require('./secrets');

let corePromise = null;
function core() {
  if (!corePromise) {
    const entry = path.join(__dirname, '..', '..', 'packages', 'core', 'index.js');
    corePromise = import(pathToFileURL(entry).href);
  }
  return corePromise;
}

// ── Config (venv location for the doodle pipeline) ──────────────────────────
const configFile = () => path.join(app.getPath('userData'), 'story-config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

// Known working venvs on this dev machine — auto-adopted (and persisted)
// when nothing is configured, so the pipeline works with zero setup clicks.
// The doctor/first-run installer replaces this convenience for end users.
const CANDIDATE_VENVS = [
  '/Volumes/My Lexar/AI Projects/Faceless YT 1/pipeline/.venv/bin/python',
];

async function makePipeline() {
  const { DoodlePipeline } = await core();
  const cfg = readConfig();
  let pipeline = new DoodlePipeline(cfg.venvPython ? { venvPython: cfg.venvPython } : {});
  if (!fs.existsSync(pipeline.venvPython)) {
    const found = CANDIDATE_VENVS.find((p) => fs.existsSync(p));
    if (found) {
      cfg.venvPython = found;
      writeConfig(cfg);
      pipeline = new DoodlePipeline({ venvPython: found });
    }
  }
  return pipeline;
}

function sendProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('story:progress', payload);
  }
}

async function openProject(dir) {
  const { Project } = await core();
  return Project.load(dir);
}

async function summarize(project) {
  const { stageStatus, validateScript, getStyle } = await core();
  let scriptCheck = null;
  try {
    scriptCheck = validateScript(project.manifest.script || '', getStyle(project.manifest.style));
  } catch { /* unknown style — leave null */ }
  return {
    ok: true,
    dir: project.dir,
    manifest: project.manifest,
    status: stageStatus(project),
    scriptCheck,
  };
}

const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

function requireProjectDirectory(dir, { creating = false } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new Error('Choose an absolute project folder first.');
  }
  const resolved = path.resolve(dir);
  let stat;
  try { stat = fs.statSync(resolved); } catch { throw new Error(`Project folder does not exist: ${resolved}`); }
  if (!stat.isDirectory()) throw new Error(`Project path is not a folder: ${resolved}`);
  const manifest = path.join(resolved, 'project.json');
  if (creating && fs.existsSync(manifest)) {
    throw new Error(`Refusing to overwrite existing manifest: ${manifest}`);
  }
  if (!creating && !fs.existsSync(manifest)) {
    throw new Error(`This folder is not a Vidmyo Story project: ${resolved}`);
  }
  return resolved;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.webm': 'video/webm',
};

function register() {
  const nativeGoogle = require('./googleOAuth').createGoogleOAuth({ app, dialog, safeStorage, shell });
  require('./storySheets').createStorySheets({ app, dialog, readConfig, writeConfig, nativeGoogle }).register(ipcMain);
  ipcMain.handle('story:pick-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a folder for the story project',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { ok: !res.canceled, dir: res.filePaths[0] || null };
  });

  ipcMain.handle('story:create', async (_evt, { dir, brief = {}, style = 'doodle-v1' } = {}) => {
    try {
      const resolved = requireProjectDirectory(dir, { creating: true });
      if (!brief || typeof brief !== 'object' || Array.isArray(brief)) throw new Error('Story brief is invalid.');
      if (JSON.stringify(brief).length > 100000) throw new Error('Story brief is too large.');
      if (style !== 'doodle-v1') throw new Error('Legacy Story projects require the doodle-v1 style.');
      const { Project } = await core();
      const project = Project.create(resolved, { brief, style });
      return await summarize(project);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:get', async (_evt, dir) => {
    try { return await summarize(await openProject(requireProjectDirectory(dir))); } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:set-script', async (_evt, dir, text) => {
    try {
      const project = await openProject(dir);
      project.manifest.script = String(text || '');
      project.save();
      return await summarize(project);
    } catch (err) { return fail(err); }
  });

  // Long-running pipeline stages. The invoke resolves when the stage ends;
  // story:progress events narrate start/done/error along the way.
  ipcMain.handle('story:run-stage', async (_evt, dir, stage, opts = {}) => {
    try {
      const mod = await core();
      const project = await openProject(dir);
      const pipeline = await makePipeline();
      const voOpts = () => ({
        force: !!opts.force,
        ...(opts.voice === 'elevenlabs' ? { source: 'elevenlabs', ttsOverride: elevenLabsTts } : {}),
      });
      const runners = {
        voiceover: () => mod.stageVoiceover(project, pipeline, voOpts()),
        beats: () => mod.stageBeats(project, pipeline),
        // One click from script to reviewable scenes: voiceover + beats +
        // prompt scaffolding (beats does the scaffolding internally).
        'to-scenes': async () => {
          sendProgress({ stage: 'voiceover', phase: 'start' });
          await mod.stageVoiceover(project, pipeline, voOpts());
          sendProgress({ stage: 'voiceover', phase: 'done' });
          sendProgress({ stage: 'beats', phase: 'start' });
          await mod.stageBeats(project, pipeline);
          sendProgress({ stage: 'beats', phase: 'done' });
        },
        assemble: () => mod.stageAssemble(project, pipeline, opts),
        finalize: () => mod.stageFinalize(project, pipeline, opts),
      };
      if (!runners[stage]) return fail(new Error(`unknown stage "${stage}"`));
      sendProgress({ stage, phase: 'start' });
      await runners[stage]();
      sendProgress({ stage, phase: 'done' });
      return await summarize(project);
    } catch (err) {
      sendProgress({ stage, phase: 'error', message: String(err.message || err) });
      return fail(err);
    }
  });

  ipcMain.handle('story:approve-scene', async (_evt, dir, sceneId) => {
    try {
      const project = await openProject(dir);
      project.approveScene(sceneId);
      return await summarize(project);
    } catch (err) { return fail(err); }
  });

  // Attach an image file to a scene (file picker), saved into <dir>/images/
  // under the scene id so assemble.py finds it.
  ipcMain.handle('story:attach-image', async (_evt, dir, sceneId) => {
    try {
      const res = await dialog.showOpenDialog({
        title: `Choose the image for scene ${sceneId}`,
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
      const src = res.filePaths[0];
      const imagesDir = path.join(dir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });
      const dest = path.join(imagesDir, `${sceneId}${path.extname(src).toLowerCase() || '.png'}`);
      fs.copyFileSync(src, dest);
      const project = await openProject(dir);
      project.acceptSceneArtifact(sceneId, dest);
      return await summarize(project);
    } catch (err) { return fail(err); }
  });

  // Which source the Story tab's scene-image ⚡ uses. Default (Google Flow) is
  // free but manual — the app can't generate, so ⚡ is hidden and you Attach.
  ipcMain.handle('story:get-image-config', async () => {
    try {
      const { getImageSource, resolveImageModel } = await core();
      const cfg = readConfig();
      const source = getImageSource(cfg.imageSource);
      return {
        ok: true,
        imageSource: source.id,
        imageModel: resolveImageModel(source.id, cfg.imageModel),
      };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:set-image-config', async (_evt, { imageSource, imageModel = null } = {}) => {
    try {
      const { IMAGE_SOURCES, resolveImageModel } = await core();
      // Strict on write (unlike the tolerant read): never persist a source id
      // that no longer exists, or the Story tab silently falls back forever.
      const source = IMAGE_SOURCES.find((s) => s.id === imageSource);
      if (!source) return fail(new Error(`unknown image source "${imageSource}"`));
      const model = resolveImageModel(source.id, imageModel);
      const cfg = readConfig();
      cfg.imageSource = source.id;
      cfg.imageModel = model;
      writeConfig(cfg);
      return { ok: true, imageSource: source.id, imageModel: model };
    } catch (err) { return fail(err); }
  });

  // Generate one scene image through the configured PAID cloud source (the
  // user's own key). The free default path remains Google Flow via
  // agent/manual attach — this is the in-product alternative for users who
  // prefer paying per image.
  ipcMain.handle('story:generate-scene', async (_evt, dir, sceneId, { model = null } = {}) => {
    try {
      const { JobStore, runJob, getImageSource, resolveImageModel, buildGenerationParams, makeGenerationAdapter } = await core();
      const project = await openProject(dir);
      const scene = project.getScene(sceneId);
      if (!scene.prompt) return fail(new Error(`${sceneId} has no image prompt yet`));

      const cfg = readConfig();
      const source = getImageSource(cfg.imageSource);
      if (source.manual) {
        return fail(new Error(`Story image source is "${source.name}", which has no API — generate there and use Attach…, or pick a cloud source in Settings → Story.`));
      }
      const key = getSecret(source.provider);
      if (!key) return fail(new Error(`No ${source.name} key saved — add it in Settings → Providers, or attach an image manually (Google Flow is the free path).`));

      const imageModel = resolveImageModel(source.id, model || cfg.imageModel);
      // The doodle style locks 16:9; each provider's dialect lives in core/generation.js.
      const params = buildGenerationParams(source.id, 'image', { prompt: scene.prompt, aspect: '16:9' });
      const adapter = makeGenerationAdapter(source.id, { key, model: imageModel, kind: 'image' });

      const store = new JobStore();
      const job = store.create({
        type: 'image',
        provider: source.id,
        project: project.manifest.id,
        params,
      });
      sendProgress({ stage: `image:${sceneId}`, phase: 'start', message: `${source.name} · ${imageModel}` });
      const done = await runJob(store, job.id, adapter, {
        outDir: path.join(dir, 'images'),
        pollMs: adapter.pollMs || 1500,
      });
      if (done.state !== 'done') {
        sendProgress({ stage: `image:${sceneId}`, phase: 'error', message: done.error });
        return fail(new Error(done.error || `job ended in state ${done.state}`));
      }
      // Rename the job-named artifact to the scene id so assemble.py finds it.
      const produced = done.artifacts[0].path;
      const dest = path.join(dir, 'images', `${sceneId}${path.extname(produced) || '.png'}`);
      fs.renameSync(produced, dest);
      project.acceptSceneArtifact(sceneId, dest);
      sendProgress({ stage: `image:${sceneId}`, phase: 'done' });
      return await summarize(project);
    } catch (err) {
      sendProgress({ stage: `image:${sceneId}`, phase: 'error', message: String(err.message || err) });
      return fail(err);
    }
  });

  // ── ElevenLabs voiceover (paid alternative to local Kokoro) ─────────────
  // Key from the keychain ('elevenlabs' in Settings). Voice/model overridable
  // via story-config.json { elevenLabsVoiceId, elevenLabsModelId }. Output is
  // converted to the pipeline's expected mono 24 kHz wav with ffmpeg.
  async function elevenLabsTts(scriptFile, outWav) {
    const key = getSecret('elevenlabs');
    if (!key) throw new Error('No ElevenLabs key saved — add it in Settings, or switch the voice back to Kokoro (free).');
    const cfg = readConfig();
    const voiceId = cfg.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB'; // premade "Adam" — calm narrator
    const modelId = cfg.elevenLabsModelId || 'eleven_multilingual_v2';
    const text = fs.readFileSync(scriptFile, 'utf8');

    await confirmNarration(dialog, { modelId, voiceId, text });

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const mp3 = path.join(os.tmpdir(), `vidmyo-vo-${Date.now()}.mp3`);
    fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-i', mp3, '-ar', '24000', '-ac', '1', outWav],
        { env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
        (err, _o, stderr) => err ? reject(new Error(`ffmpeg convert failed: ${String(stderr).slice(-200)}`)) : resolve());
    });
    fs.unlinkSync(mp3);
  }

  // Read a file belonging to a story project (scene thumbnails, render
  // playback). Strictly scoped: the path must live inside the given project
  // dir, and that dir must actually be a Vidmyo project.
  ipcMain.handle('story:read-file', async (_evt, dir, filePath) => {
    try {
      const root = path.resolve(dir);
      if (!fs.existsSync(path.join(root, 'project.json'))) {
        return fail(new Error('not a story project dir'));
      }
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(root + path.sep)) {
        return fail(new Error('path outside the project'));
      }
      const ext = path.extname(resolved).toLowerCase();
      return { ok: true, bytes: new Uint8Array(fs.readFileSync(resolved)), mime: MIME[ext] || 'application/octet-stream' };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:readiness', async () => {
    try {
      const pipeline = await makePipeline();
      return { ok: true, ...pipeline.readiness(), venvPython: pipeline.venvPython };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:set-venv', async (_evt, venvPython) => {
    try {
      if (venvPython && !fs.existsSync(venvPython)) {
        return fail(new Error(`No file at ${venvPython}`));
      }
      const cfg = readConfig();
      if (venvPython) cfg.venvPython = venvPython;
      else delete cfg.venvPython;
      writeConfig(cfg);
      const pipeline = await makePipeline();
      return { ok: true, ...pipeline.readiness(), venvPython: pipeline.venvPython };
    } catch (err) { return fail(err); }
  });

  // One-time env build (large downloads — the renderer shows consent first).
  ipcMain.handle('story:setup-env', async () => {
    try {
      const pipeline = await makePipeline();
      sendProgress({ stage: 'setup-env', phase: 'start' });
      await pipeline.setupEnv();
      sendProgress({ stage: 'setup-env', phase: 'done' });
      return { ok: true, ...pipeline.readiness() };
    } catch (err) {
      sendProgress({ stage: 'setup-env', phase: 'error', message: String(err.message || err) });
      return fail(err);
    }
  });
}

module.exports = { register, makePipeline, readConfig, requireProjectDirectory };
