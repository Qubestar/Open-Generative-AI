// Story Studio bridge — runs @vidmyo/core in the Electron main process and
// exposes a narrow story:* IPC surface to the renderer (core is Node-only:
// fs, child_process). Same pattern as secrets.js / netProxy.js.
//
// core is ESM and this file is CJS, so it's loaded once via dynamic import().
// In packaged builds packages/core ships in the asar (see package.json
// build.files) — core has zero npm dependencies.

const { ipcMain, dialog, app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

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

async function makePipeline() {
  const { DoodlePipeline } = await core();
  const cfg = readConfig();
  return new DoodlePipeline(cfg.venvPython ? { venvPython: cfg.venvPython } : {});
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

function register() {
  ipcMain.handle('story:pick-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a folder for the story project',
      properties: ['openDirectory', 'createDirectory'],
    });
    return { ok: !res.canceled, dir: res.filePaths[0] || null };
  });

  ipcMain.handle('story:create', async (_evt, { dir, brief = {}, style = 'doodle-v1' } = {}) => {
    try {
      const { Project } = await core();
      const project = Project.create(dir, { brief, style });
      return await summarize(project);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:get', async (_evt, dir) => {
    try { return await summarize(await openProject(dir)); } catch (err) { return fail(err); }
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
      const runners = {
        voiceover: () => mod.stageVoiceover(project, pipeline, opts),
        beats: () => mod.stageBeats(project, pipeline),
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

module.exports = { register };
