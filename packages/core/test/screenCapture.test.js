import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  validateCaptureRequest,
  buildCaptureArgs,
  CursorSampler,
  matchRecordingToDisplay,
  mapCursorToRecording,
  detectDwellEvents,
  startGovernedCapture,
  shiftTelemetryToCaptureClock,
} from '../src/screenCapture.js';
import { ResourceGovernor } from '../src/governor.js';

function createTempDir(prefix = 'vidmyo-screencap-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validateCaptureRequest enforces parameters and prevents path traversal', () => {
  // Valid
  assert.ok(validateCaptureRequest({
    videoDeviceIndex: 0,
    fps: 30,
    maxDurationSec: 60,
    outputPath: '/tmp/test.mp4',
  }));

  // Missing video device
  assert.throws(
    () => validateCaptureRequest({ fps: 30, outputPath: '/tmp/test.mp4' }),
    /videoDeviceIndex is required/,
  );

  // Invalid fps
  assert.throws(
    () => validateCaptureRequest({ videoDeviceIndex: 0, fps: 45, outputPath: '/tmp/test.mp4' }),
    /Invalid fps: 45/,
  );

  // Invalid duration
  assert.throws(
    () => validateCaptureRequest({ videoDeviceIndex: 0, fps: 30, maxDurationSec: 0, outputPath: '/tmp/test.mp4' }),
    /Invalid maxDurationSec/,
  );
  assert.throws(
    () => validateCaptureRequest({ videoDeviceIndex: 0, fps: 30, maxDurationSec: 8000, outputPath: '/tmp/test.mp4' }),
    /Invalid maxDurationSec/,
  );

  // Path traversal attempt
  assert.throws(
    () => validateCaptureRequest({ videoDeviceIndex: 0, fps: 30, outputPath: '/tmp/../etc/test.mp4' }),
    /relative path traversal/,
  );

  // Non-MP4 output
  assert.throws(
    () => validateCaptureRequest({ videoDeviceIndex: 0, fps: 30, outputPath: '/tmp/test.mkv' }),
    /must end with \.mp4/,
  );
});

test('buildCaptureArgs builds fragmented MP4 and R3 audio mix matrix', () => {
  const caps = {
    availableEncoders: ['libx264', 'aac'],
    encoders: { libx264: true, h264_videotoolbox: false, aac: true },
  };

  // 1. Video only (no audio)
  const noAudio = buildCaptureArgs({
    videoDeviceIndex: 0,
    fps: 30,
    outputPath: '/tmp/out1.mp4',
    caps,
  });
  assert.ok(noAudio.args.includes('-an'));
  assert.ok(noAudio.args.includes('+frag_keyframe+empty_moov+default_base_moof'));
  assert.ok(noAudio.args.includes('0:none'));
  // Requested input fps plus an explicit output `-r` so the file is the requested
  // rational rate (device-mode selection on this host is a tracked blocker).
  const inFpsIdx = noAudio.args.indexOf('-framerate');
  assert.ok(inFpsIdx >= 0 && noAudio.args[inFpsIdx + 1] === '30', 'input -framerate must be the requested fps');
  const rIdx = noAudio.args.indexOf('-r');
  assert.ok(rIdx >= 0 && noAudio.args[rIdx + 1] === '30', 'output -r must be the requested fps');

  // 2. Mic audio only
  const micOnly = buildCaptureArgs({
    videoDeviceIndex: 1,
    audioDeviceIndex: 0,
    fps: 60,
    maxDurationSec: 120,
    outputPath: '/tmp/out2.mp4',
    caps,
  });
  assert.ok(micOnly.args.includes('-an') === false);
  assert.ok(micOnly.args.includes('1:0'));
  assert.ok(micOnly.args.includes('-t'));
  assert.ok(micOnly.args.includes('120'));

  // 3. Mic + System audio (R3 audio mix)
  const bothAudio = buildCaptureArgs({
    videoDeviceIndex: 0,
    audioDeviceIndex: 0,
    systemAudioDeviceIndex: 2,
    fps: 30,
    outputPath: '/tmp/out3.mp4',
    caps,
  });
  assert.ok(bothAudio.args.includes('-filter_complex'));
  const filterIdx = bothAudio.args.indexOf('-filter_complex');
  const filterExpr = bothAudio.args[filterIdx + 1];
  assert.ok(filterExpr.includes('amix=inputs=2:normalize=0:dropout_transition=0'));
  assert.ok(filterExpr.includes('aresample=48000'));
});

test('CursorSampler operates at 30 Hz with 2px movement filter and 500ms heartbeat', () => {
  let curPoint = { x: 100, y: 100 };
  let simulatedTimeMs = 0;
  const now = () => simulatedTimeMs;

  let tickCallback = null;
  const setIntervalImpl = (fn) => {
    tickCallback = fn;
    return 123;
  };
  const clearIntervalImpl = () => {
    tickCallback = null;
  };

  const sampler = new CursorSampler({
    getCursorPoint: () => curPoint,
    now,
    setIntervalImpl,
    clearIntervalImpl,
  });

  sampler.start();

  // Tick 0: initial sample kept
  sampler.sample();
  assert.equal(sampler.count, 1);

  // Tick 1: tiny movement (1px) within 50ms -> skipped
  simulatedTimeMs += 33.3;
  curPoint = { x: 100.5, y: 100.8 };
  sampler.sample();
  assert.equal(sampler.count, 1, 'Sub-2px movement must be skipped');

  // Tick 2: significant movement (10px) -> kept
  simulatedTimeMs += 33.3;
  curPoint = { x: 110, y: 100 };
  sampler.sample();
  assert.equal(sampler.count, 2, 'Movement >= 2px must be kept');

  // Tick 3: no movement, but 500ms elapse -> forced heartbeat sample kept
  simulatedTimeMs += 501;
  sampler.sample();
  assert.equal(sampler.count, 3, 'Heartbeat sample must be kept after 500ms');

  const samples = sampler.stop();
  assert.equal(samples.length, 3);
  assert.equal(samples[0].x, 100);
  assert.equal(samples[1].x, 110);
});

test('matchRecordingToDisplay and mapCursorToRecording at scale 2 and uncertain cases', () => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
    { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
  ];

  // 1. Single exact resolution match (3840 x 2160 = 1920*2 x 1080*2)
  const match1 = matchRecordingToDisplay(displays, { recordingWidth: 3840, recordingHeight: 2160 });
  assert.equal(match1.telemetryStatus, 'ok');
  assert.equal(match1.matchedDisplay.id, 1);

  // Mapped point at scale 2
  const point = { tMonotonicMs: 500, x: 200, y: 150 };
  const mapped = mapCursorToRecording(point, match1.matchedDisplay, { recordingWidth: 3840, recordingHeight: 2160 });
  assert.equal(mapped.x, 400);
  assert.equal(mapped.y, 300);

  // 2. No matching display
  const matchNone = matchRecordingToDisplay(displays, { recordingWidth: 1280, recordingHeight: 720 });
  assert.equal(matchNone.telemetryStatus, 'display_mapping_uncertain');
  assert.equal(matchNone.matchedDisplay, null);

  // 3. Multiple matching displays -> uncertain
  const duplicateDisplays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
  ];
  const matchDup = matchRecordingToDisplay(duplicateDisplays, { recordingWidth: 1920, recordingHeight: 1080 });
  assert.equal(matchDup.telemetryStatus, 'display_mapping_uncertain');
});

test('detectDwellEvents identifies pauses >= 600ms within 80px radius with heuristic label', () => {
  const samples = [
    { tMonotonicMs: 0, x: 500, y: 500 },
    { tMonotonicMs: 200, x: 505, y: 502 },
    { tMonotonicMs: 400, x: 502, y: 508 },
    { tMonotonicMs: 700, x: 504, y: 501 }, // 700ms in same area -> dwell!
    { tMonotonicMs: 900, x: 900, y: 900 }, // Moved away
    { tMonotonicMs: 1000, x: 905, y: 905 }, // Short dwell (100ms) -> not detected
  ];

  const dwells = detectDwellEvents(samples, { dwellDurationMs: 600, radiusPx: 80 });
  assert.equal(dwells.length, 1);
  assert.equal(dwells[0].type, 'dwell');
  assert.equal(dwells[0].label, 'heuristic, not clicks');
  assert.ok(dwells[0].durationMs >= 600);
});

test('CursorSampler tracks a wall-clock start so telemetry can be shifted to the capture clock', () => {
  let monotonic = 0;
  let wall = 1000000;
  const sampler = new CursorSampler({
    getCursorPoint: () => ({ x: 10, y: 10 }),
    intervalMs: 33,
    now: () => monotonic,
    wallClockNow: () => wall,
  });
  sampler.start();
  assert.equal(sampler.startedAtWallClockMs, 1000000);
  monotonic = 500;
  wall = 1000500;
  const samples = sampler.stop();
  assert.ok(Array.isArray(samples));
});

test('shiftTelemetryToCaptureClock subtracts the sampler->capture offset and drops pre-roll samples', () => {
  // capture starts 300 ms after the sampler began: offset = 500 - 200 = 300
  const telemetry = [
    { tMonotonicMs: 200, x: 1, y: 1 }, // before capture -> dropped
    { tMonotonicMs: 1000, x: 2, y: 2 }, // -> 700
    { tMonotonicMs: 1200, x: 3, y: 3 }, // -> 900
  ];
  const shifted = shiftTelemetryToCaptureClock(telemetry, { captureT0Ms: 500, samplerStartedAtMs: 200 });
  assert.equal(shifted.length, 2);
  assert.equal(shifted[0].tMonotonicMs, 700);
  assert.equal(shifted[1].tMonotonicMs, 900);
  assert.equal(shifted[0].x, 2);

  // Missing timestamps -> unchanged (never silently reinterpreted)
  const unchanged = shiftTelemetryToCaptureClock(telemetry, { captureT0Ms: null, samplerStartedAtMs: 200 });
  assert.deepEqual(unchanged.map((s) => s.tMonotonicMs), [200, 1000, 1200]);

  assert.deepEqual(shiftTelemetryToCaptureClock([], { captureT0Ms: 1, samplerStartedAtMs: 2 }), []);
});

test('startGovernedCapture: governor exclusivity, denied admission, stop and cancel', async () => {
  const tempDir = createTempDir();
  const governor = new ResourceGovernor({ governorDir: tempDir });

  // SAFETY: this test uses fake PIDs (EventEmitter stand-ins), so it must inject
  // no-op signal seams. Otherwise process.kill would signal whatever real host
  // process happens to own pid 99901 (review blocker 1).
  const safeSignals = { killImpl: () => {}, livenessImpl: () => false };

  const fakeChild = (outFile) => {
    const ee = new EventEmitter();
    ee.pid = 99901;
    ee.stderr = new EventEmitter();
    ee.kill = (sig) => {
      // Create output file on SIGINT to simulate FFmpeg muxer finish
      if (sig === 'SIGINT') {
        fs.writeFileSync(outFile, Buffer.alloc(1024));
      }
      setImmediate(() => ee.emit('exit', 0, sig));
    };
    return ee;
  };

  const outFile1 = path.join(tempDir, 'test_record1.mp4');

  // 1. Successful capture start and stop
  let capturedProc = null;
  const session = await startGovernedCapture({
    videoDeviceIndex: 0,
    fps: 30,
    outputPath: outFile1,
    governor,
    jobId: 'job_rec_1',
    spawnImpl: () => {
      capturedProc = fakeChild(outFile1);
      setImmediate(() => {
        capturedProc.stderr.emit('data', 'Input #0, avfoundation, from \'0:none\':\n');
      });
      return capturedProc;
    },
    caps: { availableEncoders: ['libx264', 'aac'], encoders: { libx264: true } },
    getCursorPoint: () => ({ x: 100, y: 100 }),
    ...safeSignals,
  });

  assert.equal(session.jobId, 'job_rec_1');
  assert.ok(session.pid);

  // 2. Second start while first holds heavy slot is REFUSED
  const outFile2 = path.join(tempDir, 'test_record2.mp4');
  await assert.rejects(
    startGovernedCapture({
      videoDeviceIndex: 0,
      fps: 30,
      outputPath: outFile2,
      governor,
      jobId: 'job_rec_2',
      spawnImpl: () => fakeChild(outFile2),
      ...safeSignals,
    }),
    /(admission|Resource limit reached|busy)/i,
    'Second heavy job must be refused while first is running',
  );

  // Stop first session
  const stopResult = await session.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.outputPath, outFile1);
  assert.ok(stopResult.fileSize > 0);

  // Now that session 1 is stopped, heavy slot is freed: session 3 can start
  const outFile3 = path.join(tempDir, 'test_record3.mp4');
  let cancelProc = null;
  const session3 = await startGovernedCapture({
    videoDeviceIndex: 0,
    fps: 30,
    outputPath: outFile3,
    governor,
    jobId: 'job_rec_3',
    spawnImpl: () => {
      cancelProc = fakeChild(outFile3);
      fs.writeFileSync(outFile3, Buffer.alloc(512));
      return cancelProc;
    },
    caps: { availableEncoders: ['libx264', 'aac'], encoders: { libx264: true } },
    ...safeSignals,
  });

  // Cancel session 3: kills process and deletes partial file
  assert.ok(fs.existsSync(outFile3));
  const cancelResult = await session3.cancel();
  assert.equal(cancelResult.cancelled, true);
  assert.ok(!fs.existsSync(outFile3), 'Cancelled recording must delete partial output file');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
