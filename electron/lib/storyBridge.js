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

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.webm': 'video/webm',
};

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

  // Generate one scene image through a PAID cloud provider (fal, user's key).
  // The free default path remains Google Flow via agent/manual attach — this
  // is the in-product alternative for users who prefer paying per image.
  ipcMain.handle('story:generate-scene', async (_evt, dir, sceneId, { model = null } = {}) => {
    try {
      const { JobStore, runJob, falAdapter } = await core();
      const project = await openProject(dir);
      const scene = project.getScene(sceneId);
      if (!scene.prompt) return fail(new Error(`${sceneId} has no image prompt yet`));
      const key = getSecret('fal');
      if (!key) return fail(new Error('No fal.ai key saved — add it in Settings → Providers, or attach an image manually (Google Flow is the free path).'));

      const cfg = readConfig();
      const falModel = model || cfg.imageModel || 'fal-ai/flux/schnell';
      const store = new JobStore();
      const job = store.create({
        type: 'image',
        provider: 'fal',
        project: project.manifest.id,
        params: { prompt: scene.prompt, image_size: 'landscape_16_9' },
      });
      sendProgress({ stage: `image:${sceneId}`, phase: 'start', message: falModel });
      const done = await runJob(store, job.id, falAdapter({ model: falModel, key }), {
        outDir: path.join(dir, 'images'),
        pollMs: 1500,
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

  // ── Tracker sheet (read-only; Vidmyo never writes the production tracker)
  // Two access paths, tried in order:
  //   1. Public CSV export — works for any link-shared sheet, no Google auth.
  //      This is the sellable-product path: the user pastes a sheet URL.
  //   2. The gws CLI (Google Workspace, authenticated) — dev-machine fallback
  //      for private sheets.
  // Default sheet is the Doodle 1 queue; override via story:set-sheet.
  const DEFAULT_SHEET_ID = '1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo';

  const sheetIdFromInput = (input) => {
    const m = String(input || '').match(/\/d\/([\w-]{20,})/);
    return m ? m[1] : (/^[\w-]{20,}$/.test(String(input || '').trim()) ? String(input).trim() : null);
  };

  // Minimal RFC-correct CSV parser (quoted fields may contain commas,
  // quotes, and newlines — sheet descriptions do).
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  async function readSheetValues(sheetId, range) {
    // Path 1: public CSV export (link-shared sheets).
    try {
      const res = await fetch(
        `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&range=${encodeURIComponent(range)}`,
        { redirect: 'follow' },
      );
      const text = await res.text();
      if (res.ok && !text.trimStart().startsWith('<')) {
        return { values: parseCsv(text), via: 'public-link' };
      }
    } catch { /* fall through to gws */ }
    // Path 2: authenticated gws CLI.
    const data = await gwsRead(sheetId, range).catch((err) => {
      throw new Error(`Could not read the sheet. Make it link-readable (Share → Anyone with the link → Viewer) or sign in with gws. (${err.message})`);
    });
    return { values: data.values || [], via: 'gws' };
  }

  function gwsRead(sheetId, range) {
    return new Promise((resolve, reject) => {
      execFile('gws', ['sheets', '+read', '--spreadsheet', sheetId, '--range', range, '--format', 'json'],
        { timeout: 20000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
        (err, stdout) => {
          if (err) { reject(new Error(`gws failed: ${String(err.message).slice(0, 300)}`)); return; }
          try {
            // gws may print a keyring notice before the JSON.
            const jsonStart = stdout.indexOf('{');
            resolve(JSON.parse(stdout.slice(jsonStart)));
          } catch (e) { reject(new Error(`gws returned unparseable output`)); }
        });
    });
  }

  ipcMain.handle('story:set-sheet', async (_evt, input) => {
    const id = sheetIdFromInput(input);
    if (!id) return fail(new Error('Paste a Google Sheet URL (or its ID).'));
    const cfg = readConfig();
    cfg.sheetId = id;
    writeConfig(cfg);
    return { ok: true, sheetId: id };
  });

  ipcMain.handle('story:sheet-rows', async () => {
    try {
      const sheetId = readConfig().sheetId || DEFAULT_SHEET_ID;
      const data = await readSheetValues(sheetId, 'A1:E60');
      const rows = (data.values || []).slice(1)
        .map((r, i) => ({
          row: i + 2, // 1-based sheet row (header is row 1)
          status: r[0] || '',
          videoNum: r[1] || '',
          title: r[2] || '',
          hook: r[3] || '',
          topic: r[4] || '',
        }))
        .filter((r) => r.title);
      return { ok: true, sheetId, via: data.via, rows };
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('story:create-from-sheet', async (_evt, { dir, row } = {}) => {
    try {
      if (!dir || !row) return fail(new Error('dir and row are required'));
      const sheetId = readConfig().sheetId || DEFAULT_SHEET_ID;
      const data = await readSheetValues(sheetId, `A${row}:E${row}`);
      const r = data.values?.[0];
      if (!r || !r[2]) return fail(new Error(`Sheet row ${row} has no Working Title`));
      const { Project } = await core();
      const project = Project.create(dir, {
        brief: {
          topic: r[2],
          hook: r[3] || '',
          angle: r[4] || '',
          videoNum: r[1] || '',
          sheetRow: row,
          sheetId,
        },
      });
      return await summarize(project);
    } catch (err) { return fail(err); }
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

module.exports = { register };
