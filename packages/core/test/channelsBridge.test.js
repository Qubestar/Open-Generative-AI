import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChannelsBridge } = require('../../../electron/lib/channelsBridge.js');

function harness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-channels-'));
  const userData = path.join(root, 'user-data');
  const chosen = path.join(root, 'chosen');
  fs.mkdirSync(userData); fs.mkdirSync(chosen);
  const handlers = new Map();
  const bridge = createChannelsBridge({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { isPackaged: false, getPath: () => userData },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) },
    shell: { openPath: async () => '' },
    core: () => import('../index.js'),
    deviceId: 'desktop_test',
    ...overrides,
  });
  bridge.register();
  const invoke = (name, ...args) => handlers.get(`channels:${name}`)(null, ...args);
  return { root, chosen, bridge, invoke };
}

test('channels bridge requires a native root selection and persists a reopenable queue', async () => {
  const h = harness();
  try {
    const denied = await h.invoke('create', { root: h.chosen, channel: { name: 'Denied' } });
    assert.equal(denied.ok, false);
    const picked = await h.invoke('pick-root');
    assert.deepEqual(picked, { ok: true, dir: fs.realpathSync(h.chosen) });
    const created = await h.invoke('create', { root: picked.dir, channel: { name: 'Curio', defaults: { kind: 'story' } } });
    assert.equal(created.ok, true);
    const queued = await h.invoke('add-video', created.dir, { title: 'The forgotten road', status: 'ready', priority: 80 });
    assert.equal(queued.manifest.videos.length, 1);
    const reopened = await h.invoke('get', created.dir);
    assert.equal(reopened.manifest.videos[0].title, 'The forgotten road');
    assert.equal((await h.invoke('recent')).channels[0].name, 'Curio');
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('channels bridge analyzes public references and adds a reviewed 10-video plan', async () => {
  const analyzed = {
    profile: { channelId: 'UCfixture', title: 'Reference' },
    analysis: { opportunities: [{ videoId: 'v1', title: 'Strong topic', score: 82, evidence: [] }] },
  };
  const h = harness({
    youtube: { analyze: async input => ({ ...analyzed, input }) },
    planner: { plan: async input => ({
      source: 'fixture', warnings: [], ideas: Array.from({ length: input.count }, (_, index) => ({
        title: `Idea ${index + 1}`, hook: 'Hook', angle: 'Angle', pillar: input.strategy.pillars[index % input.strategy.pillars.length],
        kind: input.defaults.kind, style: input.defaults.style, priority: 100 - index,
      })),
    }) },
  });
  try {
    const root = await h.invoke('pick-root');
    const created = await h.invoke('create', { root: root.dir, channel: {
      name: 'Planner', research: { mode: 'niche', niche: 'History', goals: 'Explain clearly' },
      strategy: { language: 'English', audience: 'Curious adults', positioning: 'Clear history' },
    } });
    const analysis = await h.invoke('analyze-youtube', { mode: 'examples', exampleUrls: ['@reference'] });
    assert.equal(analysis.analysis.profile.title, 'Reference');
    const planned = await h.invoke('plan', created.dir, { count: 10, niche: 'History', referenceUrls: ['@reference'] });
    assert.equal(planned.items.length, 10);
    const added = await h.invoke('add-planned', created.dir, planned.items.slice(0, 3));
    assert.equal(added.manifest.videos.length, 3);
    assert.equal(added.manifest.videos.every(video => video.status === 'ready'), true);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('channels bridge serializes claims and prepares a bounded creative brief', async () => {
  const h = harness();
  try {
    const root = await h.invoke('pick-root');
    const created = await h.invoke('create', { root: root.dir, channel: {
      name: 'Animations', strategy: { language: 'Polish' },
      defaults: { kind: 'animation', style: 'editorial-collage', aspect: '9:16', durationSec: 60 },
    } });
    const queued = await h.invoke('add-video', created.dir, { title: 'A city in motion', hook: 'Look closer', status: 'ready' });
    const id = queued.manifest.videos[0].id;
    const [first, second] = await Promise.all([
      h.invoke('claim-video', created.dir, id, { source: 'channels' }),
      h.invoke('claim-video', created.dir, id, { source: 'channels' }),
    ]);
    assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
    const handoff = await h.invoke('prepare-brief', created.dir, id);
    assert.equal(handoff.ok, true);
    assert.equal(handoff.section, 'animation');
    assert.equal(handoff.brief.topic, 'A city in motion');
    assert.deepEqual(handoff.brief.sourceChannel, { channelId: created.manifest.id, videoId: id });
    assert.equal(Object.hasOwn(handoff.brief.sourceChannel, 'dir'), false);
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test('channels bridge keeps Google Tracker mutations inside the authorized workspace', async () => {
  const sheets = {
    create: async workspace => {
      workspace.update({ tracker: { sheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', tab: 'Videos', syncMode: 'google-sheets' } });
      return { ok: true, action: 'created', spreadsheetId: workspace.snapshot().tracker.sheetId };
    },
    pull: async workspace => ({ ok: true, action: 'pull-unchanged', spreadsheetId: workspace.snapshot().tracker.sheetId }),
    push: async workspace => ({ ok: true, action: 'push-unchanged', spreadsheetId: workspace.snapshot().tracker.sheetId }),
  };
  const h = harness({ sheets });
  try {
    const root = await h.invoke('pick-root');
    const created = await h.invoke('create', { root: root.dir, channel: { name: 'Tracker' } });
    const tracker = await h.invoke('tracker-create', created.dir, {});
    assert.equal(tracker.ok, true);
    assert.equal(tracker.manifest.tracker.syncMode, 'google-sheets');
    assert.equal((await h.invoke('tracker-pull', created.dir)).action, 'pull-unchanged');
    assert.equal((await h.invoke('tracker-push', created.dir)).action, 'push-unchanged');
  } finally { h.bridge.stop(); fs.rmSync(h.root, { recursive: true, force: true }); }
});
