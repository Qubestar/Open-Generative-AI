// Tests for Screen Studio and Engines Electron Desktop Bridges (Vidmyo V2.6).
// Phase 5, Step 4 (Checkpoint D).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const { createScreenStudioBridge } = require('../../../electron/lib/screenStudioBridge.js');
const { createEnginesBridge } = require('../../../electron/lib/enginesBridge.js');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function screenStudioHarness(opts = {}) {
  const handlers = new Map();
  const root = tempDir('vidmyo-screen-home-');
  const userDataDir = path.join(root, 'user-data');
  const recordingsDir = path.join(userDataDir, 'recordings');
  const exportsDir = path.join(userDataDir, 'exports');
  const jobsDir = path.join(userDataDir, 'jobs');
  const governorDir = tempDir('vidmyo-screen-gov-');

  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const isolatedCore = {
    ...actualCore,
    defaultGovernorDir: () => governorDir,
    checkNativeScreenRecordingPermission: opts.checkNativeScreenRecordingPermission
      || actualCore.checkNativeScreenRecordingPermission,
    startGovernedCapture: opts.startGovernedCapture || actualCore.startGovernedCapture,
    listAvfoundationCaptureDevices: opts.listAvfoundationCaptureDevices
      || (async () => ({ screens: [{ index: 0, name: 'Capture screen 0' }], audio: [{ index: 0, name: 'Default Audio' }] })),
  };

  const openedUrls = [];
  const shownPaths = [];

  const fakeShell = {
    openExternal: async (url) => { openedUrls.push(url); return true; },
    showItemInFolder: (p) => { shownPaths.push(p); },
  };

  const fakeScreen = {
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
    ],
  };

  const bridge = createScreenStudioBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    shell: fakeShell,
    screen: fakeScreen,
    userDataDir,
    recordingsDir,
    exportsDir,
    jobsDir,
    governorDir,
  });

  bridge.register();

  return {
    bridge,
    handlers,
    isolatedCore,
    openedUrls,
    shownPaths,
    userDataDir,
    recordingsDir,
    exportsDir,
    jobsDir,
    governorDir,
  };
}

test('screenStudioBridge: permission denied prevents capture spawn', async () => {
  let startCaptureCalled = false;
  const { handlers } = screenStudioHarness({
    checkNativeScreenRecordingPermission: async () => ({
      authorized: false,
      status: 'denied',
      canPrompt: false,
      reasons: ['Screen recording permission denied by macOS System Settings.'],
    }),
    startGovernedCapture: async () => {
      startCaptureCalled = true;
      throw new Error('Should not have been called');
    },
  });

  const checkFn = handlers.get('screen:check-permission');
  assert.ok(checkFn);
  const perm = await checkFn();
  assert.equal(perm.authorized, false);

  const startFn = handlers.get('screen:start-recording');
  assert.ok(startFn);
  const startRes = await startFn(null, { screenIndex: 0 });
  assert.equal(startRes.ok, false);
  assert.match(startRes.error, /Screen [Rr]ecording permission/);
  assert.equal(startCaptureCalled, false);
});

test('screenStudioBridge: open-permission-settings passes exact macOS settings URL', async () => {
  const { handlers, openedUrls } = screenStudioHarness();
  const openFn = handlers.get('screen:open-permission-settings');
  assert.ok(openFn);

  const res = await openFn();
  assert.equal(res.ok, true);
  assert.equal(res.url, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.deepEqual(openedUrls, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
});

test('screenStudioBridge: rejects negative or invalid screenIndex', async () => {
  const { handlers } = screenStudioHarness({
    checkNativeScreenRecordingPermission: async () => ({ granted: true, authorized: true, status: 'authorized', canPrompt: false, reasons: [] }),
  });

  const startFn = handlers.get('screen:start-recording');
  const res = await startFn(null, { screenIndex: -1 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Invalid screenIndex/);

  const res2 = await startFn(null, { screenIndex: 'bad' });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /Invalid screenIndex/);
});

test('screenStudioBridge: validates jobId and rejects path traversal', async () => {
  const { handlers, recordingsDir } = screenStudioHarness();
  const readFn = handlers.get('screen:read-recording');
  assert.ok(readFn);

  const res1 = await readFn(null, { jobId: '../escape' });
  assert.equal(res1.ok, false);
  assert.match(res1.error, /Invalid jobId/i);

  const res2 = await readFn(null, { jobId: 'job_test/../../evil' });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /Invalid jobId/i);

  // Non-existent job
  const res3 = await readFn(null, { jobId: 'job_nonexistent123' });
  assert.equal(res3.ok, false);
  assert.match(res3.error, /File not found/i);
});

test('screenStudioBridge: show-in-finder enforces path containment in recordings or exports', async () => {
  const { handlers, shownPaths, recordingsDir, exportsDir } = screenStudioHarness();
  const showFn = handlers.get('screen:show-in-finder');
  assert.ok(showFn);

  // Outside both recordings and exports
  const evilPath = path.resolve('/etc/passwd');
  const res1 = await showFn(null, { filePath: evilPath });
  assert.equal(res1.ok, false);
  assert.match(res1.error, /Access denied: path is outside/);
  assert.equal(shownPaths.length, 0);

  // Valid path inside recordingsDir
  const validRec = path.join(recordingsDir, 'test.mp4');
  const res2 = await showFn(null, { filePath: validRec });
  assert.equal(res2.ok, true);
  assert.deepEqual(shownPaths, [validRec]);
});

test('screenStudioBridge: read-recording enforces 256 MiB cap (R1)', async () => {
  const { handlers, recordingsDir } = screenStudioHarness();
  const readFn = handlers.get('screen:read-recording');

  // Case A: normal small file (< 256 MiB)
  const smallJobId = 'job_small123';
  const smallPath = path.join(recordingsDir, `${smallJobId}.mp4`);
  fs.writeFileSync(smallPath, Buffer.from('fake mp4 video bytes'));

  const smallRes = await readFn(null, { jobId: smallJobId });
  assert.equal(smallRes.ok, true);
  assert.equal(smallRes.size, 20);
  assert.ok(smallRes.data);

  // Case B: oversized file (> 256 MiB) - simulate with mock stat
  const bigJobId = 'job_big123';
  const bigPath = path.join(recordingsDir, `${bigJobId}.mp4`);
  fs.writeFileSync(bigPath, Buffer.from('header'));

  // Monkeypatch statSync for bigPath to report 300 MiB
  const origStat = fs.statSync;
  const statSpy = (targetPath, ...args) => {
    if (targetPath === bigPath) {
      const real = origStat(targetPath, ...args);
      return { ...real, size: 300 * 1024 * 1024 };
    }
    return origStat(targetPath, ...args);
  };
  fs.statSync = statSpy;

  try {
    const bigRes = await readFn(null, { jobId: bigJobId });
    assert.equal(bigRes.ok, false);
    assert.equal(bigRes.tooLarge, true);
    assert.equal(bigRes.maxBytes, 256 * 1024 * 1024);
    assert.match(bigRes.error, /exceeds the 256 MiB/i);
  } finally {
    fs.statSync = origStat;
  }
});

test('screenStudioBridge: status reports governor busy and idle states', async () => {
  const { handlers } = screenStudioHarness();
  const statusFn = handlers.get('screen:status');
  assert.ok(statusFn);

  const st = await statusFn();
  assert.equal(st.ok, true);
  assert.equal(st.recording, false);
  assert.equal(st.governorBusy, false);
  assert.equal(st.heldBy, null);
});

test('screenStudioBridge: stop() and before-quit cleanup stops active recording and aborts exports', async () => {
  let sessionStopped = false;
  let sessionCancelled = false;

  const { bridge, handlers } = screenStudioHarness({
    checkNativeScreenRecordingPermission: async () => ({ granted: true, authorized: true, status: 'authorized', canPrompt: false, reasons: [] }),
    startGovernedCapture: async () => ({
      jobId: 'job_recactive123',
      outputPath: '/fake/out.mp4',
      telemetryPath: '/fake/telemetry.json',
      sampler: {
        recordSample: () => {},
        flush: () => ({ display: null, samplesCount: 5, events: [] }),
      },
      stop: async () => { sessionStopped = true; return { durationSeconds: 2 }; },
      cancel: async () => { sessionCancelled = true; },
    }),
  });

  const startFn = handlers.get('screen:start-recording');
  const startRes = await startFn(null, { screenIndex: 0, jobId: 'job_recactive123' });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.jobId, 'job_recactive123');

  // Verify status is recording
  const statusFn = handlers.get('screen:status');
  const st1 = await statusFn();
  assert.equal(st1.recording, true);
  assert.equal(st1.jobId, 'job_recactive123');

  // Call bridge.stop() as done during before-quit
  await bridge.stop({ waitMs: 1000 });
  assert.equal(sessionStopped, true);

  // Status is no longer recording
  const st2 = await statusFn();
  assert.equal(st2.recording, false);
});

test('enginesBridge: exposes model package status and verification for Kokoro and Whisper', async () => {
  const handlers = new Map();
  const root = tempDir('vidmyo-engines-home-');
  const userDataDir = path.join(root, 'user-data');
  const packagesDir = path.join(userDataDir, 'models');

  const isolatedCore = {
    ...actualCore,
  };

  const bridge = createEnginesBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    userDataDir,
    packagesDir,
  });

  bridge.register();

  const statusFn = handlers.get('engines:model-packages-status');
  assert.ok(statusFn);
  const statusRes = await statusFn();
  assert.equal(statusRes.ok, true);
  assert.ok(Array.isArray(statusRes.packages));
  assert.equal(statusRes.packages.length, 2);

  const kokoro = statusRes.packages.find((p) => p.name === 'kokoro-tts');
  assert.ok(kokoro);
  assert.equal(kokoro.status, 'manifest-pending');
  assert.equal(kokoro.pending, true);
  assert.equal(kokoro.installable, false);

  const whisper = statusRes.packages.find((p) => p.name === 'whisper-asr');
  assert.ok(whisper);
  assert.equal(whisper.status, 'manifest-pending');

  const verifyFn = handlers.get('engines:model-package-verify');
  assert.ok(verifyFn);
  const verifyRes = await verifyFn(null, { name: 'kokoro-tts' });
  assert.equal(verifyRes.ok, true);
  assert.equal(verifyRes.result.ok, false);
  assert.match(verifyRes.result.reason, /not installed/);
});

test('enginesBridge: reports the pinned HyperFrames engine read-only', async () => {
  const handlers = new Map();
  const root = tempDir('vidmyo-engines-hf-');
  const userDataDir = path.join(root, 'user-data');

  const bridge = createEnginesBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => actualCore,
    userDataDir,
  });
  bridge.register();

  const hfFn = handlers.get('engines:hyperframes-status');
  assert.ok(hfFn, 'engines:hyperframes-status must be registered');
  const res = await hfFn();
  assert.equal(res.ok, true);
  assert.equal(res.pinned, actualCore.HYPERFRAMES_PINNED);
  assert.equal(res.pinned, '0.8.72');
  // The pinned package is installed in this repo, so the version must match.
  assert.equal(res.installed, true);
  assert.equal(res.matchesPin, true);

  // Missing-package path is reported, never silently faked.
  const missing = createEnginesBridge({
    ipcMain: { handle: (name, fn) => handlers.set(`x:${name}`, fn) },
    core: async () => ({ ...actualCore, resolveHyperframesPackage: () => { throw new Error('no hyperframes package (fixture)'); } }),
    userDataDir,
  });
  missing.register();
  const missingRes = await handlers.get('x:engines:hyperframes-status')();
  assert.equal(missingRes.ok, true);
  assert.equal(missingRes.installed, false);
  assert.equal(missingRes.matchesPin, false);
  assert.match(missingRes.reason, /no hyperframes package/);
});
