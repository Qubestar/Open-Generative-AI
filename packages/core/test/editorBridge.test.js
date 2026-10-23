// Editor desktop bridge — IPC surface, path policy and payload mapping.
// Electron is never loaded: ipcMain, dialog, shell, BrowserWindow and app are faked,
// and the service is a recording stub, so this suite opens no window and renders nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEditorBridge } = require('../../../electron/lib/editorBridge.js');

function harness({ dialogPaths = [], serviceOverrides = {} } = {}) {
  const handlers = new Map();
  const sent = [];
  const calls = [];
  const job = {
    contract_version: 1, job_id: 'job_editor_1', state: 'queued', mode: 'original', engine: 'v1',
    stage: 'probe', progress: 0, stages: [], outputs: [], warnings: [],
  };
  const service = {
    capabilities: async () => ({ contract_version: 1, engines: [{ id: 'v1', name: 'V1', modes: ['original', 'custom'] }] }),
    start: args => { calls.push(['start', args]); return job; },
    get: jobId => { calls.push(['get', jobId]); return { ...job, job_id: jobId, output_dir: '/tmp/out' }; },
    list: options => { calls.push(['list', options]); return { contract_version: 1, count: 0, jobs: [] }; },
    cancel: jobId => ({ ...job, job_id: jobId, state: 'cancelled' }),
    retry: jobId => ({ ...job, job_id: 'job_editor_2', job_id_old: jobId }),
    listTemplates: options => { calls.push(['listTemplates', options]); return { contract_version: 1, count: 0, templates: [] }; },
    saveTemplate: args => { calls.push(['saveTemplate', args]); return { contract_version: 1, template: { id: 'style-abc123' } }; },
    deleteTemplate: id => ({ contract_version: 1, id, removed: true }),
    analyzeExamples: args => { calls.push(['analyzeExamples', args]); return { contract_version: 1, job_id: 'job_analysis_1', state: 'queued' }; },
    getAnalysis: jobId => ({ contract_version: 1, job_id: jobId, state: 'done', style: { cut_median_s: 0.7 } }),
    readArtifact: (jobId, artifact) => ({ contract_version: 1, artifact, value: { beats: [] } }),
    close: async () => {},
    ...serviceOverrides,
  };
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const dialog = {
    showOpenDialog: async () => {
      const paths = dialogPaths.shift();
      return paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] };
    },
  };
  const shell = { showItemInFolder: () => {} };
  const BrowserWindow = { getAllWindows: () => [{ webContents: { send: (_channel, payload) => sent.push(payload) } }] };
  const app = { isPackaged: false, getPath: () => os.tmpdir() };
  const bridge = createEditorBridge({
    ipcMain, dialog, shell, BrowserWindow, app, serviceFactory: () => service,
  });
  bridge.register();
  return { bridge, handlers, sent, calls, service };
}

const invoke = (handlers, channel, ...args) => handlers.get(channel)(null, ...args);

test('the bridge registers every channel the preload exposes', async () => {
  const { handlers } = harness();
  for (const channel of [
    'editor:capabilities', 'editor:pick-folder', 'editor:pick-file', 'editor:start', 'editor:get-job',
    'editor:list-jobs', 'editor:cancel-job', 'editor:retry-job', 'editor:templates', 'editor:save-template',
    'editor:delete-template', 'editor:analyze-examples', 'editor:get-analysis', 'editor:read-artifact', 'editor:reveal',
  ]) {
    assert.ok(handlers.has(channel), `missing ${channel}`);
  }
});

test('Browse returns the folder the user picked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bridge-'));
  const { handlers } = harness({ dialogPaths: [[dir]] });
  const result = await invoke(handlers, 'editor:pick-folder', 'input');
  assert.equal(result.ok, true);
  assert.equal(result.path, dir);
});

test('a relative input folder is rejected before any job is created', async () => {
  const { handlers, calls } = harness();
  const result = await invoke(handlers, 'editor:start', { input_dir: 'footage/reel' });
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/i);
  assert.equal(calls.filter(entry => entry[0] === 'start').length, 0);
});

test('a real folder starts an edit and normalises the payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bridge-'));
  const { handlers, calls, sent } = harness();
  const result = await invoke(handlers, 'editor:start', {
    input_dir: dir,
    mode: 'custom',
    template_id: 'style-abc123',
    quality: 'high',
    face_share: 0.2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.job.job_id, 'job_editor_1');
  const start = calls.find(entry => entry[0] === 'start')[1];
  assert.equal(start.input, dir);
  assert.equal(start.template_id, 'style-abc123');
  assert.equal(start.options.mode, 'custom');
  assert.equal(start.options.quality, 'high');
  assert.equal(start.options.face_share, 0.2);
  assert.ok(sent.some(event => event.event === 'queued'));
});

test('a music bed must come from the picker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bridge-'));
  const bed = path.join(dir, 'bed.mp3');
  fs.writeFileSync(bed, 'not really audio');
  const { handlers, calls } = harness();
  const refused = await invoke(handlers, 'editor:start', { input_dir: dir, music_path: bed });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /picker/i);
  assert.equal(calls.filter(entry => entry[0] === 'start').length, 0);
});

test('a picked example video can be analysed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-bridge-'));
  const example = path.join(dir, 'example.mp4');
  fs.writeFileSync(example, 'not really video');
  const { handlers, calls } = harness({ dialogPaths: [[example]] });
  const picked = await invoke(handlers, 'editor:pick-file', 'example-video');
  assert.equal(picked.ok, true);
  const analysis = await invoke(handlers, 'editor:analyze-examples', { videos: [example], name: 'Reel' });
  assert.equal(analysis.ok, true);
  const call = calls.find(entry => entry[0] === 'analyzeExamples')[1];
  assert.deepEqual(call.videos, [example]);
  assert.equal(call.name, 'Reel');
});

test('editor_read-artifact only reads JSON', async () => {
  const { handlers } = harness();
  const result = await invoke(handlers, 'editor:read-artifact', 'job_editor_1', 'out/final.mp4');
  assert.equal(result.ok, false);
  assert.match(result.error, /JSON/i);
});
