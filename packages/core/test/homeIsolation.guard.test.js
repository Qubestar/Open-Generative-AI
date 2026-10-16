// Phase 3, item 1 — home isolation guard.
//
// Proves three things:
//   1. every default Vidmyo path follows `VIDMYO_HOME` (never HOME),
//   2. the Electron bridge factories accept injectable userData/jobs/exports
//      directories and production keeps app.getPath('userData'),
//   3. the guard actually FAILS when a test writes a marked file into the
//      real ~/.vidmyo (tamper self-test, written by a child process and
//      removed again), so a passing guard run is meaningful.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

import { vidmyoHome, defaultJobsDir, defaultGovernorDir, defaultPublisherQueuePath, testRunMarker, TEST_RUN_ENV } from '../index.js';
import { runGuard, scanHome, realVidmyoHome, testRunMarker as guardMarker, isTempPatternPath, TEMP_PATH_PATTERNS, WATCHED_DIRS, WATCHED_FILES } from './_setup/homeGuard.mjs';

const require = createRequire(import.meta.url);
const { createPromoBridge } = require('../../../electron/lib/promoBridge.js');
const { createAutoEditorBridge } = require('../../../electron/lib/autoEditorBridge.js');
const { createMediaBridge } = require('../../../electron/lib/mediaBridge.js');
const { createPublisherBridge } = require('../../../electron/lib/publisherBridge.js');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const realHome = realVidmyoHome();

test('vidmyoHome and every default path follow VIDMYO_HOME, never HOME', () => {
  const saved = process.env.VIDMYO_HOME;
  const savedHome = process.env.HOME;
  try {
    process.env.VIDMYO_HOME = '';
    assert.equal(vidmyoHome(), path.join(os.homedir(), '.vidmyo'));
    assert.equal(defaultJobsDir(), path.join(os.homedir(), '.vidmyo', 'jobs'));
    assert.equal(defaultGovernorDir(), path.join(os.homedir(), '.vidmyo', 'governor'));
    assert.equal(defaultPublisherQueuePath(), path.join(os.homedir(), '.vidmyo', 'publisher-queue.json'));

    const override = tempDir('vidmyo-home-override-');
    process.env.VIDMYO_HOME = override;
    assert.equal(vidmyoHome(), override);
    assert.equal(defaultJobsDir(), path.join(override, 'jobs'));
    assert.equal(defaultGovernorDir(), path.join(override, 'governor'));
    assert.equal(defaultPublisherQueuePath(), path.join(override, 'publisher-queue.json'));

    // HOME must never be part of the resolution contract: changing it while
    // VIDMYO_HOME is set must not move any Vidmyo default.
    process.env.HOME = tempDir('vidmyo-fake-home-');
    assert.equal(vidmyoHome(), override);
    assert.equal(defaultJobsDir(), path.join(override, 'jobs'));
  } finally {
    if (saved === undefined) delete process.env.VIDMYO_HOME; else process.env.VIDMYO_HOME = saved;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  }
});

test('testRunMarker is absent in production and stamped from VIDMYO_TEST_RUN in tests', () => {
  const saved = process.env.TEST_RUN_MARKER_SAVED;
  const token = process.env[TEST_RUN_ENV];
  try {
    delete process.env[TEST_RUN_ENV];
    assert.equal(testRunMarker(), null);
    process.env[TEST_RUN_ENV] = 'token-123';
    assert.equal(testRunMarker(), `VIDMYO_TEST_RUN=token-123`);
    assert.equal(guardMarker('token-123'), `VIDMYO_TEST_RUN=token-123`);
    assert.equal(guardMarker(''), null);
    assert.equal(guardMarker(undefined), null);
  } finally {
    if (token === undefined) delete process.env[TEST_RUN_ENV];
    else process.env[TEST_RUN_ENV] = token;
    if (saved === undefined) delete process.env.TEST_RUN_MARKER_SAVED;
  }
});

test('bridge factories accept injectable userData/jobs/exports directories and never fall back to the real home', () => {
  const home = tempDir('vidmyo-bridge-home-');
  const userDataDir = path.join(home, 'user-data');
  const jobsDir = path.join(userDataDir, 'jobs');
  const exportsDir = path.join(userDataDir, 'exports');
  const artifactsDir = path.join(userDataDir, 'artifacts');
  const governorDir = path.join(home, 'governor');
  const registry = new Map();

  const fakeIpc = { handle: (name, fn) => registry.set(name, fn) };
  const fakeCore = async () => {
    throw new Error('core should not be loaded by this test');
  };

  const promo = createPromoBridge({
    ipcMain: fakeIpc, core: fakeCore, userDataDir, jobsDir, exportsDir, governorDir,
  });
  assert.equal(typeof promo.register, 'function');

  const auto = createAutoEditorBridge({
    ipcMain: fakeIpc, core: fakeCore, userDataDir, jobsDir, exportsDir, governorDir,
  });
  assert.equal(typeof auto.register, 'function');

  const media = createMediaBridge({
    ipcMain: fakeIpc, core: fakeCore, userDataDir, jobsDir, exportsDir, artifactsDir, governorDir,
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder() {} },
  });
  assert.deepEqual(media.paths, { userDataDir, artifactsDir, jobsDir, exportsDir });

  const publisher = createPublisherBridge({
    ipcMain: fakeIpc, core: fakeCore, userDataDir,
    googleOAuth: { accessToken: async () => null },
  });
  assert.equal(typeof publisher.register, 'function');

  // Nothing may resolve into the real home when an override is in force.
  const saved = process.env.VIDMYO_HOME;
  try {
    process.env.VIDMYO_HOME = home;
    assert.ok(!defaultJobsDir().startsWith(realHome + path.sep));
    assert.ok(!defaultGovernorDir().startsWith(realHome + path.sep));
    assert.ok(!defaultPublisherQueuePath().startsWith(realHome + path.sep));
    assert.ok(!vidmyoHome().startsWith(realHome + path.sep));
  } finally {
    if (saved === undefined) delete process.env.VIDMYO_HOME;
    else process.env.VIDMYO_HOME = saved;
  }
});

test('promo export path check rejects sibling-prefix escapes via path.relative', async () => {
  const home = tempDir('vidmyo-promo-safe-');
  const userDataDir = path.join(home, 'user-data');
  const handlers = new Map();
  const bridge = createPromoBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => (await import('../index.js')),
    userDataDir,
    jobsDir: path.join(userDataDir, 'jobs'),
    exportsDir: path.join(userDataDir, 'exports'),
    governorDir: path.join(home, 'governor'),
  });
  bridge.register();

  const renderExport = handlers.get('promo:render-export');
  assert.ok(renderExport);

  const core = await import('../index.js');
  const script = core.generatePromoScript({
    productName: 'Vidmyo Studio',
    category: 'digital_saas',
    coreBenefit: 'automatyzację wideo',
    targetAudience: 'twórców',
    claims: [{ claim: '10x szybszy montaż', source: 'Benchmark 2026', verified: true, userExplicitlyConfirmedExperience: true }],
  });
  const edg = core.createResponsivePromoEdg(script, 'VERTICAL_9_16', { durationSec: 1, fps: 30 });

  // `user-data-evil/x.mp4` is a SIBLING PREFIX of `user-data/` — a
  // startsWith() check accepts it, path.relative() must not. The path is
  // outside both the exports dir and userData, so it must be rejected
  // before any render starts.
  const sibling = `${userDataDir}-evil${path.sep}x.mp4`;
  const res = await renderExport(null, { edg, outputPath: sibling });
  assert.equal(res.ok, false, res.error);
  assert.match(res.error, /must be within userData exports/);
  assert.ok(!fs.existsSync(sibling));
});

test('guard fails on a marked file a child process writes into the real home, then passes once removed', () => {
  const token = crypto.randomUUID();
  const marker = guardMarker(token);
  const tamperName = `job_tamper_${crypto.randomBytes(4).toString('hex')}.json`;
  const tamperPath = path.join(realHome, 'jobs', tamperName);

  const before = scanHome(realHome);

  // Tamper from a CHILD process — proves the guard does not depend on the
  // writing process being the test process itself.
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const target = path.join(os.homedir(), '.vidmyo', 'jobs', ${JSON.stringify(tamperName)});
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({
      id: ${JSON.stringify(tamperName.replace('.json', ''))},
      type: 'tamper_probe',
      state: 'queued',
      testRun: ${JSON.stringify(marker)},
    }, null, 2));
    process.stdout.write(target);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.existsSync(tamperPath), 'tamper file must exist for the probe');

  try {
    const failing = runGuard({ before, marker, home: realHome });
    assert.equal(failing.ok, false, 'guard must fail while the marked file is present');
    assert.ok(
      failing.violations.some((v) => v.path === path.posix.join('jobs', tamperName)),
      `expected jobs/${tamperName} in violations: ${JSON.stringify(failing.violations)}`,
    );
  } finally {
    fs.rmSync(tamperPath, { force: true });
  }

  const passing = runGuard({ before, marker, home: realHome });
  assert.equal(passing.ok, true, JSON.stringify(passing.violations));
  assert.ok(!passing.violations.some((v) => v.path.includes(tamperName)));
});

test('guard watch list covers jobs, exports, governor, artifacts and the publisher queue', () => {
  assert.deepEqual([...WATCHED_DIRS].sort(), ['artifacts', 'exports', 'governor', 'jobs']);
  assert.deepEqual([...WATCHED_FILES], ['publisher-queue.json']);
});

test('guard fails on an unmarked temp artifact under exports/ or artifacts/ (review R4)', () => {
  const home = tempDir('vidmyo-guard-home-');
  for (const dir of ['exports', 'artifacts', 'jobs']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  const before = scanHome(home);

  // A leaked test artifact: binary, no marker, but the run's temp name.
  fs.writeFileSync(path.join(home, 'exports', 'vidmyo-home-leak.mp4'), Buffer.from([0, 0, 0, 0]));
  fs.writeFileSync(path.join(home, 'artifacts', 'vidmyo-home-project.hf.json'), '{}');
  // An ordinary live export: no marker, no temp pattern → note only.
  fs.writeFileSync(path.join(home, 'exports', 'promo_1727000000000.mp4'), Buffer.from([1, 2, 3]));
  // jobs/ and governor/ stay marker-only, even with a temp-looking name.
  fs.writeFileSync(path.join(home, 'jobs', 'vidmyo-home-not-a-target.json'), '{}');

  const guard = runGuard({ before, marker: guardMarker('r4-token'), home });
  const paths = guard.violations.map((v) => v.path);
  assert.equal(guard.ok, false, JSON.stringify(guard));
  assert.ok(paths.includes('exports/vidmyo-home-leak.mp4'), JSON.stringify(paths));
  assert.ok(paths.includes('artifacts/vidmyo-home-project.hf.json'), JSON.stringify(paths));
  assert.ok(guard.violations.every((v) => v.reason === 'temp-pattern'));
  assert.ok(!paths.includes('exports/promo_1727000000000.mp4'), 'live export names stay notes');
  assert.ok(!paths.includes('jobs/vidmyo-home-not-a-target.json'), 'jobs/ stays marker-only');
  assert.ok(guard.notes.some((n) => n.path === 'exports/promo_1727000000000.mp4'));
});

test('isTempPatternPath only fires for exports/ and artifacts/ files', () => {
  assert.ok(TEMP_PATH_PATTERNS.length >= 2, 'default temp patterns cover the temp home and the marker');
  assert.match(isTempPatternPath('exports/vidmyo-home-a.mp4'), /vidmyo-home-/);
  assert.match(isTempPatternPath('artifacts/VIDMYO_TEST_RUN=abc.json'), /VIDMYO_TEST_RUN/);
  assert.equal(isTempPatternPath('jobs/vidmyo-home-a.json'), null, 'jobs/ is marker-only');
  assert.equal(isTempPatternPath('governor/leases/vidmyo-home-a'), null, 'governor/ is marker-only');
  assert.equal(isTempPatternPath('exports/promo_1.mp4'), null, 'ordinary exports are not temp files');
});

test('Electron bridge resolves userData from a stubbed app.getPath when no dep is injected', async () => {
  // Production path: no deps.userDataDir, only Electron's app.getPath('userData').
  const userData = tempDir('vidmyo-electron-userdata-');
  const governorDir = tempDir('vidmyo-electron-governor-');
  const handlers = new Map();

  const media = createMediaBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => (await import('../index.js')),
    app: { getPath: () => userData },
    governorDir,
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { showItemInFolder() {} },
  });
  assert.equal(media.paths.userDataDir, userData);
  assert.equal(media.paths.artifactsDir, path.join(userData, 'artifacts'));
  assert.equal(media.paths.jobsDir, path.join(userData, 'jobs'));
  assert.equal(media.paths.exportsDir, path.join(userData, 'exports'));

  const promoHandlers = new Map();
  const promo = createPromoBridge({
    ipcMain: { handle: (name, fn) => promoHandlers.set(name, fn) },
    core: async () => (await import('../index.js')),
    app: { getPath: () => userData },
    governorDir,
  });
  promo.register();

  const renderExport = promoHandlers.get('promo:render-export');
  const core = await import('../index.js');
  const script = core.generatePromoScript({
    productName: 'Vidmyo Studio',
    category: 'digital_saas',
    coreBenefit: 'automatyzację wideo',
    targetAudience: 'twórców',
    claims: [{ claim: '10x szybszy montaż', source: 'Benchmark 2026', verified: true, userExplicitlyConfirmedExperience: true }],
  });
  const edg = core.createResponsivePromoEdg(script, 'VERTICAL_9_16', { durationSec: 1, fps: 30 });

  const res = await renderExport(null, { edg, outputPath: null, isPreview: false });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.outputPath.startsWith(path.join(userData, 'exports') + path.sep),
    `default export must land in the stubbed userData/exports, got ${res.outputPath}`);
  assert.ok(!res.outputPath.startsWith(realHome + path.sep), 'never the real home');
  assert.ok(fs.existsSync(res.outputPath));
  fs.rmSync(res.outputPath, { force: true });
});
