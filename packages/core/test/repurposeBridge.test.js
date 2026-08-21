import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createRepurposeBridge } = require('../../../electron/lib/repurposeBridge.js');
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function harness() {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const jobsDir = tempDir('vidmyo-bridge-jobs-');
  class TestJobStore extends actualCore.JobStore {
    constructor() { super(jobsDir); }
  }
  const sent = [];
  const core = async () => ({
    ...actualCore,
    JobStore: TestJobStore,
    runRepurposeJob: async (store, jobId) => {
      if (store.get(jobId).state === 'queued') store.setState(jobId, 'running');
      return store.setState(jobId, 'done');
    },
  });
  const userData = tempDir('vidmyo-bridge-config-');
  const bridge = createRepurposeBridge({
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: value => sent.push(['reveal', value]) },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args) => sent.push(args) } }] },
    app: { getPath: () => userData },
    core,
    getSecret: () => null,
    execFileImpl: (_command, args, _options, callback) => {
      if (args.includes('doctor')) callback(null, JSON.stringify({ ok: false, status: 'missing' }), '');
      else callback(null, 'ready', '');
    },
  });
  return { bridge, handlers, sent, jobsDir, userData };
}

test('bridge registers once and exposes only structured Repurpose handlers', () => {
  const { bridge, handlers } = harness();
  assert.equal(bridge.register(), true);
  assert.equal(bridge.register(), false);
  assert.deepEqual([...handlers.keys()].sort(), [
    'repurpose:cancel-job', 'repurpose:create', 'repurpose:get', 'repurpose:get-config',
    'repurpose:get-job', 'repurpose:list-jobs', 'repurpose:pick-project-dir',
    'repurpose:pick-source', 'repurpose:read-artifact', 'repurpose:readiness',
    'repurpose:resume-job', 'repurpose:reveal', 'repurpose:run-stage',
    'repurpose:select-candidate', 'repurpose:set-candidate-decision', 'repurpose:set-config',
  ]);
});

test('bridge creates and opens a local project with safe candidate decisions', async () => {
  const { bridge, handlers } = harness();
  bridge.register();
  const dir = tempDir('vidmyo-bridge-project-');
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'media');
  bridge.authorizeProject(dir);
  bridge.authorizeSource(source);
  const created = await handlers.get('repurpose:create')(null, { dir, sourcePath: source });
  assert.equal(created.ok, true);
  assert.equal(created.manifest.source.type, 'local_file');
  const project = actualCore.RepurposeProject.load(dir);
  project.addCandidate({ proposedStartSec: 1, proposedEndSec: 20 });
  const approved = await handlers.get('repurpose:set-candidate-decision')(null, dir, 'clip_001', 'approved');
  assert.equal(approved.manifest.candidates[0].decision, 'approved');
  const selected = await handlers.get('repurpose:select-candidate')(null, dir, 'clip_001', true);
  assert.equal(selected.manifest.candidates[0].selected, true);
  assert.equal((await handlers.get('repurpose:get')(null, dir)).jobs.length, 0);
});

test('run-stage returns a durable job immediately and list/get responses are sanitized', async () => {
  const { bridge, handlers } = harness();
  bridge.register();
  const dir = tempDir('vidmyo-bridge-run-');
  const source = path.join(dir, 'source.mp4');
  fs.writeFileSync(source, 'media');
  actualCore.RepurposeProject.create(dir, { source: { type: 'local_file', uri: source } });
  bridge.authorizeProject(dir);
  const started = await handlers.get('repurpose:run-stage')(null, dir, 'ingest', {});
  assert.equal(started.ok, true);
  assert.equal(started.job.type, 'repurpose');
  assert.equal(Object.hasOwn(started.job, 'params'), false);
  await new Promise(resolve => setImmediate(resolve));
  const fetched = await handlers.get('repurpose:get-job')(null, started.job.id);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.job.state, 'done');
  const listed = await handlers.get('repurpose:list-jobs')(null, { projectDir: dir });
  assert.equal(listed.jobs.length, 1);
});

test('artifact reads and reveals are confined to project-owned files', async () => {
  const { bridge, handlers, sent } = harness();
  bridge.register();
  const dir = tempDir('vidmyo-bridge-artifact-');
  const artifact = path.join(dir, 'artifacts', 'result.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ value: 1 }));
  assert.equal((await handlers.get('repurpose:read-artifact')(null, dir, 'artifacts/result.json')).ok, false);
  bridge.authorizeProject(dir);
  const read = await handlers.get('repurpose:read-artifact')(null, dir, 'artifacts/result.json');
  assert.deepEqual(read.value, { value: 1 });
  assert.equal((await handlers.get('repurpose:read-artifact')(null, dir, '../../outside.json')).ok, false);
  assert.equal((await handlers.get('repurpose:read-artifact')(null, dir, 'source.mp4')).ok, false);
  assert.equal((await handlers.get('repurpose:reveal')(null, dir, 'artifacts/result.json')).ok, true);
  assert.deepEqual(sent[0], ['reveal', artifact]);
});

test('readiness is read-only and config cannot become generic process execution', async () => {
  const { bridge, handlers, userData } = harness();
  bridge.register();
  const config = await handlers.get('repurpose:set-config')(null, { modelCache: path.join(userData, 'models') });
  assert.equal(config.ok, true);
  assert.equal((await handlers.get('repurpose:set-config')(null, { python: 'python3' })).ok, false);
  assert.equal((await handlers.get('repurpose:set-config')(null, { arbitrary: 'value' })).ok, false);
  const readiness = await handlers.get('repurpose:readiness')();
  assert.equal(readiness.ok, true);
  assert.equal(readiness.readiness.downloadsPerformed, false);
  assert.equal(readiness.readiness.model.status, 'missing');
});

test('preload surface names every narrow channel and exposes no generic invoke helper', () => {
  const preload = fs.readFileSync(path.resolve(here, '../../../electron/preload.js'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('repurpose'/);
  for (const channel of [
    'pick-source', 'pick-project-dir', 'create', 'get', 'run-stage', 'resume-job',
    'cancel-job', 'get-job', 'list-jobs', 'set-candidate-decision', 'select-candidate',
    'read-artifact', 'reveal', 'get-config', 'set-config', 'readiness',
  ]) assert.match(preload, new RegExp(`repurpose:${channel}`));
  assert.doesNotMatch(preload, /repurpose[^\n]+invoke:\s*ipcRenderer\.invoke/);
});
