import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const { createPromoBridge } = require('../../../electron/lib/promoBridge.js');

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Each harness gets its own governor directory: the default (~/.vidmyo/governor) is shared with the real app and
// with test files running in parallel, which made heavy-slot admission fail intermittently.
// Phase 3 item 1: every bridge test runs against private mkdtemp directories
// (userData/jobs/exports/governor), so no test can read or write the real
// ~/.vidmyo even when the suite is run without the isolated wrapper.
function harness() {
  const handlers = new Map();
  const root = tempDir('vidmyo-promo-home-');
  const userDataDir = path.join(root, 'user-data');
  const jobsDir = path.join(userDataDir, 'jobs');
  const exportsDir = path.join(userDataDir, 'exports');
  const governorDir = tempDir('vidmyo-promo-governor-');
  const isolatedCore = { ...actualCore, defaultGovernorDir: () => governorDir };
  const bridge = createPromoBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    userDataDir,
    jobsDir,
    exportsDir,
    governorDir,
  });
  bridge.register();
  return { bridge, handlers, governorDir, userDataDir, jobsDir, exportsDir };
}

test('promoBridge generates validated cartoon EDG from script and character config', async () => {
  const { handlers } = harness();
  const generateCartoonEdg = handlers.get('promo:generate-cartoon-edg');
  assert.ok(generateCartoonEdg);

  const res = await generateCartoonEdg(null, {
    scriptLines: [
      { speaker: 'hero', text: 'Nagle na ekranie pojawia się niesamowity kod!' },
      { speaker: 'hero', text: 'Czy jesteś gotowy na rewolucję w AI?' },
    ],
    characterConfig: {
      id: 'hero',
      name: 'Hero Coder',
      rigType: 'chibi_anime',
      colorPalette: { primary: '#2563eb', secondary: '#38bdf8' },
    },
    aspect: '9:16',
    fps: 30,
  });

  assert.equal(res.ok, true, res.error);
  assert.ok(res.edg);
  assert.equal(res.edg.schemaVersion, '1.0.0');
  assert.equal(res.edg.canvas.aspect, '9:16');
  assert.equal(res.scenes.length, 2);
  assert.equal(res.scenes[0].visualEffects.speedlines, true);
  assert.equal(res.scenes[1].visualEffects.comicSpeechBubble.bubbleType, 'question_bubble');
});

test('promoBridge render-export routes through JobStore and enforces safe output path', async () => {
  const { handlers } = harness();
  const renderExport = handlers.get('promo:render-export');
  assert.ok(renderExport);

  const sampleScript = actualCore.generatePromoScript({
    productName: 'Vidmyo Studio',
    category: 'digital_saas',
    coreBenefit: 'automatyzację wideo',
    targetAudience: 'twórców',
    claims: [{ claim: '10x szybszy montaż', source: 'Benchmark 2026', verified: true, userExplicitlyConfirmedExperience: true }],
  });
  const edg = actualCore.createResponsivePromoEdg(sampleScript, 'VERTICAL_9_16', { durationSec: 10, fps: 30 });

  // 1. Path traversal or unsafe paths must fail closed
  const evilRes = await renderExport(null, {
    edg,
    outputPath: '/etc/evil_promo.mp4',
  });
  assert.equal(evilRes.ok, false);
  assert.match(evilRes.error, /must be within userData exports/);

  // 2. Safe export executes and records job in JobStore
  const requestedJobId = `job_promo_${Date.now()}_test`;
  const safeRes = await renderExport(null, {
    edg,
    isPreview: true,
    jobId: requestedJobId,
  });
  assert.equal(safeRes.ok, true, safeRes.error);
  assert.equal(safeRes.jobId, requestedJobId, 'client-supplied jobId must be honoured for cancel');
  assert.ok(safeRes.outputPath);
  assert.ok(fs.existsSync(safeRes.outputPath));

  // 3. An id that cannot live inside the jobs directory fails closed before rendering
  const evilIdRes = await renderExport(null, {
    edg,
    isPreview: true,
    jobId: '../escape',
  });
  assert.equal(evilIdRes.ok, false);
  assert.match(evilIdRes.error, /Invalid job id/);
});

test('promoBridge render-cartoon-export routes through JobStore and renders MP4', async () => {
  const { handlers } = harness();
  const generateCartoonEdg = handlers.get('promo:generate-cartoon-edg');
  const renderCartoonExport = handlers.get('promo:render-cartoon-export');

  const edgRes = await generateCartoonEdg(null, {
    scriptLines: ['Test animacji postaci 2D z komiksowymi dymkami.'],
    aspect: '16:9',
    fps: 30,
  });
  assert.equal(edgRes.ok, true);

  const renderRes = await renderCartoonExport(null, {
    edg: edgRes.edg,
    isPreview: true,
  });
  assert.equal(renderRes.ok, true, renderRes.error);
  assert.ok(renderRes.jobId);
  assert.ok(renderRes.outputPath);
  assert.ok(fs.existsSync(renderRes.outputPath));
});

test('promoBridge screen recording permission check is honest about TCC state', async () => {
  const { handlers } = harness();
  const checkPermission = handlers.get('promo:check-screen-recording-permission');
  assert.ok(checkPermission);

  const res = await checkPermission(null);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.permission.granted, false);
  assert.equal(res.permission.fallbackMode, 'synthetic_session_generator');
});

test('promoBridge lists real avfoundation capture devices for the native capture adapter', async () => {
  const { handlers } = harness();
  const listDevices = handlers.get('promo:list-screen-capture-devices');
  assert.ok(listDevices);

  const res = await listDevices(null);
  assert.equal(res.ok, true, res.error);
  assert.ok(Array.isArray(res.devices.video));
  assert.ok(Array.isArray(res.devices.audio));
  assert.ok(Array.isArray(res.devices.screens));
});

test('promoBridge builds Screen Studio EDG with Smart Auto-Zoom keyframes and renders real MP4', async () => {
  const { handlers } = harness();
  const generateScreenSession = handlers.get('promo:generate-screen-session');
  const buildScreenStudioEdg = handlers.get('promo:build-screen-studio-edg');
  const renderScreenStudioExport = handlers.get('promo:render-screen-studio-export');
  assert.ok(generateScreenSession);
  assert.ok(buildScreenStudioEdg);
  assert.ok(renderScreenStudioExport);

  const sessionRes = await generateScreenSession(null, { durationSec: 1.0, fps: 30 });
  assert.equal(sessionRes.ok, true, sessionRes.error);
  assert.equal(sessionRes.session.totalFrames, 30);

  const edgRes = await buildScreenStudioEdg(null, { session: sessionRes.session, aspect: '16:9', fps: 30 });
  assert.equal(edgRes.ok, true, edgRes.error);
  assert.ok(edgRes.edg);
  assert.ok(edgRes.zoomKeyframes.length > 0);

  // Missing/malformed session must fail closed, not throw an unhandled exception
  const missingSessionRes = await buildScreenStudioEdg(null, { session: null });
  assert.equal(missingSessionRes.ok, false);

  const renderRes = await renderScreenStudioExport(null, {
    edg: edgRes.edg,
    fps: 30,
    width: 320,
    height: 180,
    isPreview: true,
  });
  assert.equal(renderRes.ok, true, renderRes.error);
  assert.ok(renderRes.jobId);
  assert.ok(renderRes.outputPath);
  assert.ok(fs.existsSync(renderRes.outputPath));

  // Path traversal must still fail closed for this export type
  const evilRes = await renderScreenStudioExport(null, {
    edg: edgRes.edg,
    outputPath: '/etc/evil_screen_studio.mp4',
  });
  assert.equal(evilRes.ok, false);
  assert.match(evilRes.error, /must be within userData exports/);
});

test('promoBridge render-2d-mascot stores child process on JobStore and supports cancel-2d-mascot', async () => {
  const { handlers } = harness();
  const renderMascot = handlers.get('promo:render-2d-mascot');
  const cancelMascot = handlers.get('promo:cancel-2d-mascot');
  assert.ok(renderMascot);
  assert.ok(cancelMascot);

  // Test successful render
  const res = await renderMascot(null, {
    characterName: 'BridgeBot',
    audioDurationSec: 1.0,
    width: 320,
    height: 320,
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(res.jobId);
  assert.ok(fs.existsSync(res.outputPath));

  // Test cancel handler
  const missingCancel = await cancelMascot(null, null);
  assert.equal(missingCancel.ok, false);

  const validCancel = await cancelMascot(null, res.jobId);
  assert.equal(validCancel.ok, true);
  assert.equal(validCancel.cancelled, true);
});

test('preload exposes every promo:* handler registered in promoBridge', () => {
  const { handlers } = harness();
  const registeredEvents = Array.from(handlers.keys()).filter(k => k.startsWith('promo:'));
  assert.ok(registeredEvents.length >= 20, `Expected at least 20 promo handlers, found ${registeredEvents.length}`);

  const preloadPath = path.resolve(import.meta.dirname, '../../../electron/preload.js');
  assert.ok(fs.existsSync(preloadPath), `Preload file not found at ${preloadPath}`);
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');

  // Verify every registered promo:* handler is referenced in preload.js
  const missingInPreload = [];
  for (const eventName of registeredEvents) {
    if (!preloadSource.includes(`'${eventName}'`) && !preloadSource.includes(`"${eventName}"`)) {
      missingInPreload.push(eventName);
    }
  }

  assert.deepEqual(
    missingInPreload,
    [],
    `preload.js is missing bindings for registered promoBridge handlers: ${missingInPreload.join(', ')}`
  );
});

test('render-2d-mascot respects governor admission: refuses render when heavy slot is held', async () => {
  const { handlers, governorDir } = harness();
  const renderMascot = handlers.get('promo:render-2d-mascot');
  assert.ok(renderMascot);

  // Directly acquire the single HEAVY slot on the bridge's (isolated) governor
  const gov = new actualCore.ResourceGovernor({ governorDir });
  const blockLease = gov.acquire({
    jobId: `blocker_${Date.now()}`,
    resourceClass: actualCore.RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(blockLease.token);

  try {
    const res = await renderMascot(null, {
      characterName: 'BlockedMascotBot',
      audioDurationSec: 1.0,
      width: 320,
      height: 320,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Governor admission denied/);
  } finally {
    gov.release(blockLease.token);
  }
});

test('render-2d-mascot cancel transitions to cancelled state and releases governor slot', async () => {
  const { handlers, governorDir, jobsDir } = harness();
  const renderMascot = handlers.get('promo:render-2d-mascot');
  const cancelMascot = handlers.get('promo:cancel-2d-mascot');
  assert.ok(renderMascot);
  assert.ok(cancelMascot);

  const testJobId = `job_test_cancel_${Date.now()}`;
  const store = new actualCore.JobStore(jobsDir, {
    governorDir,
  });

  // Launch render of 6s mascot video
  const renderPromise = renderMascot(null, {
    jobId: testJobId,
    characterName: 'CancelMascotBot',
    audioDurationSec: 6.0,
    width: 320,
    height: 320,
  });

  // Wait until job is in 'running' state
  let running = false;
  for (let i = 0; i < 40; i++) {
    const j = store.get(testJobId);
    if (j && j.state === 'running') {
      running = true;
      break;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(running, 'Job should enter running state');

  // Cancel the active render
  const cancelRes = await cancelMascot(null, testJobId);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);

  // The render promise should resolve with ok: false and cancelled: true (not throw illegal transition)
  const renderRes = await renderPromise;
  assert.equal(renderRes.ok, false);

  const finalJob = store.get(testJobId);
  assert.equal(finalJob.state, 'cancelled', 'Final job state must be cancelled, never error');
  assert.equal(finalJob.checkpoints?.leaseToken, null, 'Governor lease token must be cleared');

  // Governor heavy slot must be immediately available for acquisition
  const probeLease = store.governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: actualCore.RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(probeLease.token);
  store.governor.release(probeLease.token);
});

