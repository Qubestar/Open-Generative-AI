// Cloud media bridge — generic image/video generation for the studio tabs.
// Runs @vidmyo/core (JobStore + runJob + falAdapter) in the Electron main
// process with the fal key from the OS keychain; the renderer talks through
// the narrow media:* IPC surface. Artifacts land in ~/.vidmyo/artifacts and
// job records in ~/.vidmyo/jobs — the same stores the CLI/MCP will read.

const { ipcMain, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

const ARTIFACTS_DIR = path.join(os.homedir(), '.vidmyo', 'artifacts');

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

// Only files inside the Vidmyo artifact store may be read back or revealed.
function insideArtifacts(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(ARTIFACTS_DIR + path.sep);
}

function sendProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('media:progress', payload);
  }
}

function register() {
  ipcMain.handle('media:generate', async (_evt, { kind = 'image', provider = 'fal', model, params = {} } = {}) => {
    try {
      if (!model) return fail(new Error('model endpoint id is required'));
      const mod = await core();
      const { JobStore, runJob } = mod;

      // Build the adapter for the chosen provider (key from the keychain).
      let adapter;
      if (provider === 'higgsfield') {
        const key = getSecret('higgsfield');
        if (!key) return fail(new Error('No Higgsfield key saved — add it in Settings (format KEY_ID:KEY_SECRET).'));
        adapter = mod.higgsfieldAdapter({ key, endpoint: model });
      } else {
        const key = getSecret('fal');
        if (!key) return fail(new Error('No fal.ai key saved — add it in Settings first.'));
        adapter = mod.falAdapter({ model, key });
      }

      const store = new JobStore();
      const job = store.create({ type: kind, provider, params });
      sendProgress({ jobId: job.id, phase: 'start', model });

      const done = await runJob(store, job.id, adapter, {
        outDir: ARTIFACTS_DIR,
        pollMs: kind === 'video' ? 4000 : 1500,
        maxPolls: kind === 'video' ? 400 : 200,
      });
      if (done.state !== 'done') {
        sendProgress({ jobId: job.id, phase: 'error', message: done.error });
        return fail(new Error(done.error || `job ended in state ${done.state}`));
      }
      sendProgress({ jobId: job.id, phase: 'done' });

      const artifact = done.artifacts[0].path;
      const ext = path.extname(artifact).toLowerCase();
      const out = { ok: true, jobId: done.id, path: artifact, mime: MIME[ext] || 'application/octet-stream' };
      // Images are small enough to hand back inline for immediate display.
      if (kind === 'image') {
        out.dataUrl = `data:${out.mime};base64,${fs.readFileSync(artifact).toString('base64')}`;
      }
      return out;
    } catch (err) {
      return fail(err);
    }
  });

  // Read an artifact back as bytes (video playback via blob URL).
  ipcMain.handle('media:read-file', async (_evt, p) => {
    try {
      if (!insideArtifacts(p)) return fail(new Error('path outside the artifact store'));
      const ext = path.extname(p).toLowerCase();
      return { ok: true, bytes: new Uint8Array(fs.readFileSync(p)), mime: MIME[ext] || 'application/octet-stream' };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('media:recent', async (_evt, { type = null, limit = 12 } = {}) => {
    try {
      const { JobStore } = await core();
      const store = new JobStore();
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

  ipcMain.handle('media:reveal', async (_evt, p) => {
    try {
      if (!insideArtifacts(p)) return fail(new Error('path outside the artifact store'));
      shell.showItemInFolder(path.resolve(p));
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { register };
