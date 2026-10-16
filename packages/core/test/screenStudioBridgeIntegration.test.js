// Bridge-level integration test for the real Screen Studio flow:
// start (fake avfoundation capture) -> stop (ffprobe-confirmed) -> build-edg
// (main-side EDG + shifted telemetry) -> render-export (real FFmpeg) -> cancel.
// Phase 5 review feedback: items 1-4, 6, 7, 10, 11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as actualCore from '../index.js';
import { ResourceGovernor } from '../src/governor.js';
import { runGovernedFfmpeg } from '../src/governedProcess.js';
import { resolveFfmpegBinary } from '../src/rendererAdapter.js';

const require = createRequire(import.meta.url);
const { createScreenStudioBridge } = require('../../../electron/lib/screenStudioBridge.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

async function makeFixture(dir, seconds = 2) {
  const ffmpeg = resolveFfmpegBinary();
  const governor = new ResourceGovernor({ governorDir: tempDir('vidmyo-int-gov-fixture-') });
  const fixturePath = path.join(dir, `fixture_${seconds}s.mp4`);
  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: [
      '-y',
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000',
      fixturePath,
    ],
    governor,
    jobId: 'job_int_fixture',
    resourceClass: 'heavy',
  });
  return fixturePath;
}

// A fake avfoundation child that materialises a REAL mp4 on SIGINT so the
// bridge's ffprobe confirmation and the real renderer both work on real media.
function fakeCaptureChild({ outFile, fixturePath }) {
  const ee = new EventEmitter();
  ee.pid = 99001;
  ee.stderr = new EventEmitter();
  ee.kill = (sig) => {
    if (sig === 'SIGINT') {
      try { fs.copyFileSync(fixturePath, outFile); } catch { /* ignore */ }
      setImmediate(() => ee.emit('exit', 0, 'SIGINT'));
    } else if (sig === 'SIGKILL') {
      setImmediate(() => ee.emit('exit', null, 'SIGKILL'));
    }
  };
  setImmediate(() => ee.stderr.emit('data', "Input #0, avfoundation, from '0:none':\n"));
  return ee;
}

// A fake capture child that exits on its own (duration limit / crash) without
// any stop() call, to prove the bridge clears the stale session (item 6).
function selfExitingChild({ outFile, fixturePath, delayMs = 60 }) {
  const ee = new EventEmitter();
  ee.pid = 99002;
  ee.stderr = new EventEmitter();
  ee.kill = () => {};
  setImmediate(() => ee.stderr.emit('data', "Input #0, avfoundation, from '0:none':\n"));
  setTimeout(() => {
    try { fs.copyFileSync(fixturePath, outFile); } catch { /* ignore */ }
    ee.emit('exit', 0, null);
  }, delayMs);
  return ee;
}

function makeHarness({ spawnImpl, fixturePath }) {
  const handlers = new Map();
  const root = tempDir('vidmyo-int-home-');
  const userDataDir = path.join(root, 'user-data');
  const recordingsDir = path.join(userDataDir, 'recordings');
  const exportsDir = path.join(userDataDir, 'exports');
  const jobsDir = path.join(userDataDir, 'jobs');
  const governorDir = tempDir('vidmyo-int-gov-');
  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const isolatedCore = {
    ...actualCore,
    listAvfoundationCaptureDevices: async () => ({
      screens: [{ index: 0, name: 'Capture screen 0' }],
      audio: [{ index: 0, name: 'MacBook Microphone' }],
    }),
  };

  const bridge = createScreenStudioBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => isolatedCore,
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 640, height: 360 }, scaleFactor: 1 }],
      getCursorScreenPoint: () => ({ x: 200 + Math.random() * 100, y: 150 + Math.random() * 50 }),
    },
    shell: { openExternal: async () => true, showItemInFolder: () => {} },
    desktopCapturer: { getSources: async () => [] },
    userDataDir,
    recordingsDir,
    exportsDir,
    jobsDir,
    governorDir,
    spawnImpl: spawnImpl ? () => spawnImpl() : undefined,
    // SAFETY: the fake capture children below use fake PIDs (99001/99002), so
    // every signal must go through no-op stubs and never touch a real host
    // process (review blocker 1).
    killImpl: () => {},
    livenessImpl: () => false,
  });

  bridge.register();
  return { bridge, handlers, isolatedCore, root, recordingsDir, exportsDir, jobsDir, governorDir, fixturePath };
}

test('integration: start -> stop (ffprobe confirmed) -> build-edg -> render-export (real FFmpeg) -> cancel', async () => {
  const root = tempDir('vidmyo-int-main-');
  const fixturePath = await makeFixture(root, 2);
  let captureOutFile = null;
  const { handlers, recordingsDir: recDir, exportsDir } = makeHarness({
    spawnImpl: () => fakeCaptureChild({ outFile: captureOutFile, fixturePath }),
    fixturePath,
  });

  const recordingJobId = 'job_int_recording';
  captureOutFile = path.join(recDir, `${recordingJobId}.mp4`);

  // 1. Start
  const startRes = await handlers.get('screen:start-recording')(null, {
    screenIndex: 0,
    fps: 30,
    jobId: recordingJobId,
  });
  assert.equal(startRes.ok, true, startRes.error);
  assert.equal(startRes.jobId, recordingJobId);

  const st = await handlers.get('screen:status')();
  assert.equal(st.isRecording, true);

  // Let the cursor sampler collect a few samples.
  await sleep(250);

  // 2. Stop — ffprobe must confirm the real file.
  const stopRes = await handlers.get('screen:stop-recording')();
  assert.equal(stopRes.ok, true, stopRes.error);
  assert.equal(stopRes.confirmed, true);
  assert.ok(stopRes.durationSec > 1.5 && stopRes.durationSec < 2.6, `duration=${stopRes.durationSec}`);
  assert.ok(fs.existsSync(path.join(recDir, `${recordingJobId}.mp4`)));

  // 3. Build EDG in main from the recording + stored telemetry.
  const edgRes = await handlers.get('screen:build-edg')(null, { jobId: recordingJobId, aspect: '16:9', fps: 30 });
  assert.equal(edgRes.ok, true, edgRes.error);
  assert.equal(edgRes.edgId, recordingJobId);
  assert.ok(edgRes.edg, 'build-edg must return the EDG');
  assert.equal(edgRes.telemetryStatus, 'ok');
  assert.ok(edgRes.samplesCount >= 1, `expected telemetry samples, got ${edgRes.samplesCount}`);

  // 4. Renderer-supplied EDG is rejected: arbitrary file read is impossible.
  const noEdgId = await handlers.get('screen:render-export')(null, {
    jobId: 'job_int_evil',
    edg: { meta: { source: 'recording' }, assets: { screen_source: { path: '/etc/passwd' } } },
  });
  assert.equal(noEdgId.ok, false);
  assert.match(noEdgId.error, /edgId is required/);

  const unknownEdg = await handlers.get('screen:render-export')(null, { edgId: 'job_missing_edg' });
  assert.equal(unknownEdg.ok, false);
  assert.match(unknownEdg.error, /No EDG found/);

  // 5. Real render from the main-side EDG.
  const exportJobId = 'job_int_export';
  const exportRes = await handlers.get('screen:render-export')(null, {
    jobId: exportJobId,
    edgId: recordingJobId,
    fps: 30,
    width: 640,
    height: 360,
  });
  assert.equal(exportRes.ok, true, exportRes.error);
  assert.equal(exportRes.jobId, exportJobId);
  const exportPath = path.join(exportsDir, `${exportJobId}_export.mp4`);
  assert.ok(fs.existsSync(exportPath), 'export file must exist');
  assert.ok(fs.statSync(exportPath).size > 0);

  // 6. Cancel a second render using the SAME jobId that was passed to renderExport.
  const cancelJobId = 'job_int_export_cancel';
  const renderPromise = handlers.get('screen:render-export')(null, {
    jobId: cancelJobId,
    edgId: recordingJobId,
    fps: 30,
    width: 1280,
    height: 720,
  });
  await sleep(150);
  const cancelAck = await handlers.get('screen:cancel-export')(null, cancelJobId);
  assert.equal(cancelAck.ok, true);
  assert.equal(cancelAck.jobId, cancelJobId);
  const cancelledRes = await renderPromise;
  assert.equal(cancelledRes.cancelled, true, JSON.stringify(cancelledRes));
  assert.ok(!fs.existsSync(path.join(exportsDir, `${cancelJobId}_export.mp4`)), 'cancelled export must remove the partial file');

  fs.rmSync(root, { recursive: true, force: true });
});

test('integration: ffmpeg self-exit clears the active session and finalizes the job (item 6)', async () => {
  const root = tempDir('vidmyo-int-selfexit-');
  const fixturePath = await makeFixture(root, 2);
  let outFile = null;
  const { handlers, recordingsDir, jobsDir, governorDir } = makeHarness({
    spawnImpl: () => selfExitingChild({ outFile, fixturePath }),
    fixturePath,
  });

  const jobId = 'job_int_selfexit';
  outFile = path.join(recordingsDir, `${jobId}.mp4`);

  const startRes = await handlers.get('screen:start-recording')(null, { screenIndex: 0, fps: 30, jobId });
  assert.equal(startRes.ok, true, startRes.error);

  // Wait for the self-exit observer to run and finalize the job.
  const store = new actualCore.JobStore(jobsDir, { governorDir });
  let st = await handlers.get('screen:status')();
  let record = store.get(jobId);
  const deadline = Date.now() + 5000;
  while ((st.isRecording || record?.state === 'running') && Date.now() < deadline) {
    await sleep(50);
    st = await handlers.get('screen:status')();
    record = store.get(jobId);
  }
  assert.equal(st.isRecording, false, 'status must not report isRecording:true after ffmpeg self-exits');

  // Job state is finalized (done, because ffprobe confirms the copied file).
  assert.ok(record, 'job record must exist');
  assert.equal(record.state, 'done', `expected done, got ${record.state}`);

  // Status explains why the recording ended; stop reports the same instead of
  // a stale recording or a bare "no session".
  assert.equal(st.endedUnexpectedly?.jobId, jobId);
  const stopRes = await handlers.get('screen:stop-recording')();
  assert.equal(stopRes.ok, false);
  assert.equal(stopRes.code, 'EENDED');
  assert.match(stopRes.error, /zakończyło się samo/);
  const stopAgain = await handlers.get('screen:stop-recording')();
  assert.match(stopAgain.error, /nie jest aktywne/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('bridge: build-edg rejects a recording that does not exist', async () => {
  const root = tempDir('vidmyo-int-missing-');
  const fixturePath = await makeFixture(root, 1);
  const { handlers } = makeHarness({ fixturePath });
  const res = await handlers.get('screen:build-edg')(null, { jobId: 'job_missing_rec', aspect: '16:9', fps: 30 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Recording not found/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bridge: recording option validation happens before any job is created (item 9)', async () => {
  const root = tempDir('vidmyo-int-opts-');
  const fixturePath = await makeFixture(root, 1);
  const { handlers, jobsDir, governorDir } = makeHarness({ fixturePath });

  const badFps = await handlers.get('screen:start-recording')(null, { screenIndex: 0, fps: 17, jobId: 'job_bad_fps' });
  assert.equal(badFps.ok, false);
  assert.match(badFps.error, /Invalid fps/);

  const badDuration = await handlers.get('screen:start-recording')(null, { screenIndex: 0, fps: 30, maxDurationSec: 99999, jobId: 'job_bad_dur' });
  assert.equal(badDuration.ok, false);
  assert.match(badDuration.error, /Invalid maxDurationSec/);

  const badAudio = await handlers.get('screen:start-recording')(null, { screenIndex: 0, fps: 30, audioDeviceIndex: 7, jobId: 'job_bad_audio' });
  assert.equal(badAudio.ok, false);
  assert.match(badAudio.error, /Unknown audioDeviceIndex|Invalid audioDeviceIndex/);

  const store = new actualCore.JobStore(jobsDir, { governorDir });
  assert.equal(store.get('job_bad_fps'), null, 'invalid options must not create a job');
  assert.equal(store.get('job_bad_dur'), null);
  assert.equal(store.get('job_bad_audio'), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('bridge: start-recording rejects a jobId that already exists (no recording overwrite)', async () => {
  const root = tempDir('vidmyo-int-dup-');
  const fixturePath = await makeFixture(root, 1);
  const { handlers, recordingsDir } = makeHarness({ fixturePath });

  const dupId = 'job_int_duplicate';
  const existingPath = path.join(recordingsDir, `${dupId}.mp4`);
  fs.writeFileSync(existingPath, Buffer.alloc(64));

  const res = await handlers.get('screen:start-recording')(null, { screenIndex: 0, fps: 30, jobId: dupId });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'EJOB_EXISTS');
  assert.match(res.error, /already exists/);
  assert.equal(fs.statSync(existingPath).size, 64, 'existing recording must be untouched');

  fs.rmSync(root, { recursive: true, force: true });
});
