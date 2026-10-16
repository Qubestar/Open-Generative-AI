import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const { createCleanerBridge } = require('../../../electron/lib/cleanerBridge.js');
const { parseClaudeAuthStatus } = require('../../../electron/lib/agents.js');
const preloadSource = fs.readFileSync(path.resolve('../..', 'electron', 'preload.js'), 'utf8');
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function harness({ secret = '', detectedAgents = [], core = null, execFile = null, openProjectDir = null } = {}) {
  const handlers = new Map();
  const downloads = tempDir('vidmyo-cleaner-downloads-');
  const userData = tempDir('vidmyo-cleaner-user-data-');
  const revealed = [];
  const bridge = createCleanerBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async ({ title }) => title === 'Open Cleaner project' && openProjectDir
      ? ({ canceled: false, filePaths: [openProjectDir] })
      : ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder: value => revealed.push(value) },
    app: { isPackaged: false, getPath: name => name === 'downloads' ? downloads : userData },
    agents: { detectAll: async () => detectedAgents },
    getSecret: id => id === 'openrouter' ? secret : '',
    now: () => new Date('2026-09-04T10:00:00.000Z'),
    BrowserWindow: { getAllWindows: () => [] },
    ...(core ? { core } : {}),
    ...(execFile ? { execFile } : {}),
  });
  bridge.register();
  return { bridge, handlers, downloads, revealed };
}

const codex = {
  id: 'codex', name: 'OpenAI Codex', installed: true, authed: true,
  supportsRepurpose: true, repurposeName: 'OpenAI Codex', version: '1.2.3',
};

test('Claude auth status distinguishes login from an active subscription', () => {
  assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, subscriptionType: null })), {
    authed: true, subscriptionReady: false, subscriptionType: null,
  });
  assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, subscriptionType: 'pro' })), {
    authed: true, subscriptionReady: true, subscriptionType: 'pro',
  });
});

test('Cleaner preload exposes the bounded provider switch channel', () => {
  assert.match(preloadSource, /setProvider: \(dir, providerId\) => ipcRenderer\.invoke\('cleaner:set-provider', dir, providerId\)/);
  assert.doesNotMatch(preloadSource, /cleaner:[\s\S]{0,1000}invoke: ipcRenderer\.invoke/);
});

test('Cleaner bridge creates a versioned, secret-free brief for an installed agent', async () => {
  const { bridge, handlers, downloads } = harness({ detectedAgents: [codex] });
  const sourceRoot = tempDir('vidmyo-cleaner-source-');
  const source = path.join(sourceRoot, 'Raw take.mp4');
  fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const result = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'downloads', providerMode: 'agent', providerId: 'codex', model: '',
  });
  assert.equal(result.ok, true);
  assert.equal(path.dirname(result.dir), downloads);
  assert.equal(result.manifest.version, 1);
  assert.equal(result.manifest.analysis.provider, 'codex');
  assert.equal(result.manifest.cleanup.remove_filler_words, false);
  assert.equal(result.manifest.stages.setup.state, 'completed');
  const stored = fs.readFileSync(path.join(result.dir, 'cleaner.json'), 'utf8');
  assert.doesNotMatch(stored, /api[_-]?key|secret/i);
  assert.equal((await handlers.get('cleaner:reveal')(null, result.dir)).ok, true);
  assert.equal((await handlers.get('cleaner:reveal')(null, downloads)).ok, false);
});

test('Cleaner bridge runs preparation, review override, and export through bounded adapters', async () => {
  const jobs = new Map();
  let jobNumber = 0;
  const fakeCore = async () => ({
    ...actualCore,
    JobStore: class { list() { return []; } },
    createRepurposeJob: (_store, { projectDir, stage }) => {
      const job = { id: `job_${++jobNumber}`, projectDir, stage };
      jobs.set(job.id, job);
      return job;
    },
    runRepurposeJob: async (_store, jobId) => {
      const job = jobs.get(jobId);
      const repurpose = actualCore.RepurposeProject.load(job.projectDir);
      repurpose.startStage(job.stage);
      const artifact = job.stage === 'ingest' ? 'artifacts/ingest-artifact.v1.json' : 'artifacts/transcript-artifact.v1.json';
      fs.mkdirSync(path.join(job.projectDir, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(job.projectDir, artifact), '{}');
      repurpose.completeStage(job.stage, { artifact });
      return { state: 'done' };
    },
  });
  const fakeExec = (_python, args, _options, callback) => {
    const dir = args.at(-1);
    if (args.includes('analyze')) {
      fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'artifacts', 'cleaner-plan.v1.json'), JSON.stringify({
        version: 1, summary: { segments: 1, proposed_cuts: 1 }, decisions: [{
          segment_id: 'segment_000001', start_seconds: 0, end_seconds: 1, text: 'Restart.',
          proposed: 'cut', decision: 'cut', category: 'false_start', reason: 'Restarted.',
        }],
      }));
    } else {
      fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'exports', 'cleaned-video.mp4'), 'video');
    }
    callback(null, JSON.stringify({ event: 'completed', output: 'exports/cleaned-video.mp4' }), '');
  };
  const { bridge, handlers } = harness({ detectedAgents: [codex], core: fakeCore, execFile: fakeExec });
  const source = path.join(tempDir('vidmyo-cleaner-flow-'), 'take.mp4'); fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const created = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'source', providerMode: 'agent', providerId: 'codex', model: '',
  });
  assert.equal(created.ok, true, created.error);
  const analyzed = await handlers.get('cleaner:analyze')(null, created.dir);
  assert.equal(analyzed.ok, true, analyzed.error);
  assert.equal(analyzed.manifest.stages.review.state, 'running');
  const restored = await handlers.get('cleaner:set-decision')(null, created.dir, 'segment_000001', 'keep');
  assert.equal(restored.plan.summary.proposed_cuts, 0);
  const rendered = await handlers.get('cleaner:render')(null, created.dir);
  assert.equal(rendered.ok, true);
  assert.equal(rendered.output, 'exports/cleaned-video.mp4');
  assert.equal(rendered.manifest.stages.export.state, 'completed');
});

test('Cleaner timing IPC persists a shared join and rejects ungranted projects', async () => {
  const { bridge, handlers } = harness({ detectedAgents: [codex] });
  const source = path.join(tempDir('vidmyo-timing-'), 'take.mp4'); fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const created = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'source', providerMode: 'agent', providerId: 'codex', model: '',
  });
  assert.equal(created.ok, true);
  const target = path.join(created.dir, 'artifacts', 'cleaner-plan.v1.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ decisions: [
    { segment_id: 'segment_000001', start_seconds: 0, end_seconds: 2, decision: 'cut' },
    { segment_id: 'segment_000002', start_seconds: 2, end_seconds: 4, decision: 'keep' },
  ] }));
  const update = handlers.get('cleaner:set-boundary');
  assert.equal((await update(null, created.dir, 'segment_000001', 2.2, 2)).ok, true);
  const stored = JSON.parse(fs.readFileSync(target));
  assert.equal(stored.decisions[0].end_seconds, stored.decisions[1].start_seconds);
  assert.equal(stored.decisions[1].start_seconds, 2.2);
  assert.equal((await update(null, created.dir, 'segment_000001', 2.3, 2)).ok, false);
  assert.equal((await update(null, path.dirname(created.dir), 'segment_000001', 2.3, 2.2)).ok, false);
});

test('Cleaner bridge requires a script for exact or rough modes', async () => {
  const { bridge, handlers } = harness({ detectedAgents: [codex] });
  const source = path.join(tempDir('vidmyo-cleaner-script-'), 'take.mov');
  fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const result = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'exact', scriptText: ' ', includeMp4: false,
    saveMode: 'source', providerMode: 'agent', providerId: 'codex', model: '',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Paste the exact script or rough outline/);
});

test('Cleaner API mode validates encrypted-key readiness without persisting the key', async () => {
  const { bridge, handlers } = harness({ secret: 'super-secret-token', detectedAgents: [] });
  const source = path.join(tempDir('vidmyo-cleaner-api-'), 'take.webm');
  fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const readiness = await handlers.get('cleaner:readiness')();
  assert.equal(readiness.apiProviders[0].configured, true);
  const result = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'rough', scriptText: 'Hook, demonstration, conclusion.',
    includeMp4: true, saveMode: 'source', providerMode: 'api', providerId: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
  });
  assert.equal(result.ok, true);
  const stored = fs.readFileSync(path.join(result.dir, 'cleaner.json'), 'utf8');
  assert.match(stored, /anthropic\/claude-sonnet-4\.5/);
  assert.doesNotMatch(stored, /super-secret-token/);
});

test('Cleaner bridge rejects ungranted media and custom output paths', async () => {
  const { bridge, handlers } = harness({ detectedAgents: [codex] });
  const source = path.join(tempDir('vidmyo-cleaner-grants-'), 'take.mp4');
  fs.writeFileSync(source, 'media');
  const payload = {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'custom', customOutputDir: tempDir('vidmyo-cleaner-output-'),
    providerMode: 'agent', providerId: 'codex', model: '',
  };
  assert.match((await handlers.get('cleaner:create')(null, payload)).error, /Choose this source/);
  bridge.grantSource(source);
  assert.match((await handlers.get('cleaner:create')(null, payload)).error, /Choose this custom output/);
  bridge.grantOutput(payload.customOutputDir);
  assert.equal((await handlers.get('cleaner:create')(null, payload)).ok, true);
});

test('Cleaner preserves transcription when changing from an unavailable agent', async () => {
  const claudeWithoutSubscription = {
    id: 'claude_code', name: 'Claude Code', installed: true, authed: true,
    subscriptionReady: false, supportsRepurpose: true, repurposeName: 'Claude Code', version: '2.1.231',
  };
  const { bridge, handlers } = harness({ detectedAgents: [claudeWithoutSubscription, codex] });
  const source = path.join(tempDir('vidmyo-cleaner-switch-source-'), 'take.mp4');
  fs.writeFileSync(source, 'media');
  bridge.grantSource(source);
  const rejected = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'source', providerMode: 'agent', providerId: 'claude_code', model: '',
  });
  assert.match(rejected.error, /cannot verify its subscription/);
  const created = await handlers.get('cleaner:create')(null, {
    sourcePath: source, scriptMode: 'freestyle', scriptText: '', includeMp4: true,
    saveMode: 'source', providerMode: 'agent', providerId: 'codex', model: '',
  });
  const file = path.join(created.dir, 'cleaner.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.analysis = { mode: 'agent', provider: 'claude_code', model: null };
  manifest.stages.ingest.state = 'completed';
  manifest.stages.transcribe.state = 'completed';
  manifest.stages.decide_cuts.state = 'failed';
  fs.writeFileSync(file, JSON.stringify(manifest));
  const switched = await handlers.get('cleaner:set-provider')(null, created.dir, 'codex');
  assert.equal(switched.ok, true, switched.error);
  assert.equal(switched.manifest.analysis.provider, 'codex');
  assert.equal(switched.manifest.stages.transcribe.state, 'completed');
  assert.equal(switched.manifest.stages.decide_cuts.state, 'pending');
});

test('Cleaner analysis repairs projects created by the intake-only bridge', async () => {
  const source = path.join(tempDir('vidmyo-cleaner-legacy-source-'), 'take.mp4');
  fs.writeFileSync(source, 'media');
  const projectDir = tempDir('vidmyo-cleaner-legacy-project-');
  fs.writeFileSync(path.join(projectDir, 'cleaner.json'), JSON.stringify({
    id: 'cleaner_legacy', version: 1,
    source: { type: 'local_file', uri: source },
    intake: { script_mode: 'freestyle', script_text: null, language: 'en' },
    cleanup: { remove_retakes: true, remove_false_starts: true, remove_dead_air: true, remove_filler_words: false, pause_treatment: 'balanced', review_before_export: true },
    delivery: { include_mp4: true, save_mode: 'downloads' },
    analysis: { mode: 'agent', provider: 'codex', model: null },
    stages: {
      setup: { state: 'completed' }, transcribe: { state: 'pending' },
      decide_cuts: { state: 'pending' }, review: { state: 'pending' }, export: { state: 'pending' },
    },
    created_at: '2026-09-04T10:00:00.000Z', updated_at: '2026-09-04T10:00:00.000Z',
  }));
  const jobs = new Map();
  const fakeCore = async () => ({
    ...actualCore,
    JobStore: class { list() { return []; } },
    createRepurposeJob: (_store, params) => {
      const job = { id: `job_${params.stage}`, ...params };
      jobs.set(job.id, job);
      return job;
    },
    runRepurposeJob: async (_store, jobId) => {
      const job = jobs.get(jobId);
      const project = actualCore.RepurposeProject.load(job.projectDir);
      project.startStage(job.stage);
      const artifact = job.stage === 'ingest' ? 'artifacts/ingest-artifact.v1.json' : 'artifacts/transcript-artifact.v1.json';
      fs.mkdirSync(path.join(job.projectDir, 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(job.projectDir, artifact), '{}');
      project.completeStage(job.stage, { artifact });
      return { state: 'done' };
    },
  });
  const fakeExec = (_python, args, _options, callback) => {
    const dir = args.at(-1);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'cleaner-plan.v1.json'), JSON.stringify({
      version: 1, summary: { segments: 0, proposed_cuts: 0 }, decisions: [],
    }));
    callback(null, JSON.stringify({ event: 'completed' }), '');
  };
  const { handlers } = harness({
    detectedAgents: [codex], core: fakeCore, execFile: fakeExec, openProjectDir: projectDir,
  });
  const opened = await handlers.get('cleaner:pick-project')();
  assert.equal(opened.ok, true);
  const analyzed = await handlers.get('cleaner:analyze')(null, projectDir);
  assert.equal(analyzed.ok, true, analyzed.error);
  assert.equal(analyzed.manifest.stages.ingest.state, 'completed');
  assert.equal(analyzed.manifest.stages.transcribe.state, 'completed');
  assert.equal(fs.existsSync(path.join(projectDir, 'repurpose.json')), true);
});
