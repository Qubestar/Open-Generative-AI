import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateSyntheticScreenSession,
  computeAutoZoomKeyframes,
  createStudioCanvasConfig,
  createScreenStudioEdgTimeline,
  renderScreenStudioExport,
  DesktopCaptureAdapter,
  checkNativeScreenRecordingPermission,
  parseAvfoundationDevices,
  listAvfoundationCaptureDevices,
  createCursorTelemetrySampler,
  startNativeScreenCapture,
} from '../src/screenStudio.js';
import { EventEmitter } from 'node:events';

test('generateSyntheticScreenSession produces deterministic telemetry aligned with frames', () => {
  const session = generateSyntheticScreenSession({
    durationSec: 2.0,
    fps: 30,
    interactions: [{ timeSec: 1.0, x: 800, y: 400, type: 'click', targetName: 'Play' }],
  });

  assert.equal(session.totalFrames, 60);
  assert.equal(session.telemetry.length, 60);
  assert.equal(session.telemetry[0].frame, 0);
  assert.equal(session.telemetry[59].frame, 59);

  const clickFrame = session.telemetry.find(t => t.clickEvent && t.clickEvent.type === 'click');
  assert.ok(clickFrame);
  assert.equal(clickFrame.clickEvent.targetName, 'Play');
});

test('computeAutoZoomKeyframes smoothly focuses on click coordinates without exceeding borders', () => {
  const session = generateSyntheticScreenSession({
    durationSec: 3.0,
    fps: 30,
    interactions: [{ timeSec: 1.0, x: 1900, y: 1050, type: 'click' }], // Near bottom-right edge
  });

  const zoomKeyframes = computeAutoZoomKeyframes(session.telemetry, {
    screenWidth: 1920,
    screenHeight: 1080,
    zoomScale: 1.5,
  });

  assert.equal(zoomKeyframes.length, session.telemetry.length);

  // Before click, scale = 1.0
  assert.equal(zoomKeyframes[0].scale, 1.0);

  // During click hold, scale = 1.5 and clamped inside bounds
  const zoomed = zoomKeyframes.find(k => k.scale === 1.5);
  assert.ok(zoomed);
  assert.ok(zoomed.centerX < 1900); // Clamped so right border isn't cropped
  assert.ok(zoomed.centerY < 1050); // Clamped so bottom border isn't cropped
});

test('createStudioCanvasConfig builds styling properties for 4K background and floating webcam', () => {
  const config = createStudioCanvasConfig({
    backgroundPreset: 'GRADIENT_PURPLE',
    aspect: '16:9',
    webcamOverlay: { enabled: true, x: 100, y: 100, radius: 80, removeBackground: true },
  });

  assert.equal(config.aspect, '16:9');
  assert.ok(config.background.includes('radial-gradient'));
  assert.equal(config.window.cornerRadius, 16);
  assert.ok(config.webcamOverlay.removeBackground);
});

test('createScreenStudioEdgTimeline builds valid EDG timeline from session and telemetry', () => {
  const session = generateSyntheticScreenSession({ durationSec: 1.5, fps: 30 });
  const zoomKeyframes = computeAutoZoomKeyframes(session.telemetry);
  const canvasConfig = createStudioCanvasConfig();

  const edg = createScreenStudioEdgTimeline(session, zoomKeyframes, canvasConfig, {
    fps: 30,
    aspect: '16:9',
    title: 'Screen Capture Test',
  });

  assert.equal(edg.schemaVersion, '1.0.0');
  assert.equal(edg.totalTimelineFrames, 45);
  assert.equal(edg.tracks.length, 3);
  assert.equal(edg.meta.studio, 'screen_studio');
});

test('renderScreenStudioExport renders real MP4 video with studio canvas styling', async () => {
  const session = generateSyntheticScreenSession({ durationSec: 1.0, fps: 30 });
  const zoomKeyframes = computeAutoZoomKeyframes(session.telemetry);
  const canvasConfig = createStudioCanvasConfig();
  const edg = createScreenStudioEdgTimeline(session, zoomKeyframes, canvasConfig, { fps: 30 });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-screen-export-'));
  const exportPath = path.join(tmpDir, 'screen_studio_export.mp4');

  const result = await renderScreenStudioExport(edg, exportPath, {
    fps: 30,
    width: 640,
    height: 360,
  });

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(exportPath));
  assert.ok(fs.statSync(exportPath).size > 1000);
});

test('DesktopCaptureAdapter reports TCC status honestly and indicates fallback generator', () => {
  const adapterWithoutTcc = new DesktopCaptureAdapter({ tccGranted: false });
  const statusWithout = adapterWithoutTcc.checkScreenRecordingPermission();
  assert.equal(statusWithout.granted, false);
  assert.match(statusWithout.reason, /Screen Recording permission not granted/);
  assert.equal(statusWithout.fallbackMode, 'synthetic_session_generator');

  const adapterWithTcc = new DesktopCaptureAdapter({ tccGranted: true });
  const statusWith = adapterWithTcc.checkScreenRecordingPermission();
  assert.equal(statusWith.granted, true);
});

test('checkNativeScreenRecordingPermission reads the real macOS TCC status when wired in', () => {
  const denied = checkNativeScreenRecordingPermission({
    platform: 'darwin',
    getMediaAccessStatus: (kind) => (kind === 'screen' ? 'denied' : 'granted'),
  });
  assert.equal(denied.granted, false);
  assert.equal(denied.status, 'denied');
  assert.match(denied.reason, /Screen Recording permission is 'denied'/);

  const granted = checkNativeScreenRecordingPermission({
    platform: 'darwin',
    getMediaAccessStatus: () => 'granted',
  });
  assert.equal(granted.granted, true);
});

test('checkNativeScreenRecordingPermission is honest about non-macOS and unwired environments', () => {
  const noBackend = checkNativeScreenRecordingPermission({ platform: 'win32' });
  assert.equal(noBackend.granted, false);
  assert.match(noBackend.reason, /macOS/);

  const unwired = checkNativeScreenRecordingPermission({ platform: 'darwin', getMediaAccessStatus: null });
  assert.equal(unwired.granted, false);
  assert.match(unwired.reason, /unavailable outside the Electron main process/);
});

test('parseAvfoundationDevices extracts screens, cameras and microphones from real ffmpeg -list_devices output', () => {
  const sample = [
    '[AVFoundation indev @ 0x1] AVFoundation video devices:',
    '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x1] [1] Capture screen 0',
    '[AVFoundation indev @ 0x1] [2] Capture screen 1',
    '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone',
    '[AVFoundation indev @ 0x1] [1] BlackHole 2ch',
  ].join('\n');

  const parsed = parseAvfoundationDevices(sample);
  assert.equal(parsed.video.length, 3);
  assert.equal(parsed.audio.length, 2);
  assert.deepEqual(parsed.screens.map(s => s.index), [1, 2], 'both displays identified as screen-capture devices');
  assert.equal(parsed.video[0].isScreen, false);
});

test('listAvfoundationCaptureDevices spawns ffmpeg -list_devices and parses its stderr', async () => {
  const spawnCalls = [];
  const fakeSpawn = (binary, args) => {
    spawnCalls.push({ binary, args });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      proc.stderr.emit('data', Buffer.from('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] Capture screen 0\n'));
      proc.emit('close', 1); // ffmpeg exits non-zero for -list_devices; expected
    }, 0);
    return proc;
  };

  const devices = await listAvfoundationCaptureDevices({ ffmpegBinary: null, spawnImpl: fakeSpawn });
  assert.equal(spawnCalls[0].args.includes('-list_devices'), true);
  assert.equal(devices.screens.length, 1);
  assert.equal(devices.screens[0].index, 0);
});

test('createCursorTelemetrySampler records real cursor points on a monotonic clock', () => {
  let tick = 0;
  const points = [{ x: 10, y: 10 }, { x: 20, y: 40 }, { x: 30, y: 90 }];
  let scheduled = null;
  const sampler = createCursorTelemetrySampler({
    intervalMs: 10,
    getCursorPoint: () => points[Math.min(tick, points.length - 1)],
    now: () => tick * 10,
    setIntervalImpl: (fn) => { scheduled = fn; return 'timer'; },
    clearIntervalImpl: () => { scheduled = null; },
  });

  sampler.start();
  tick = 1; scheduled();
  tick = 2; scheduled();
  const samples = sampler.stop();

  assert.equal(samples.length, 2);
  assert.equal(samples[0].tMonotonicMs, 10);
  assert.deepEqual([samples[0].x, samples[0].y], [20, 40]);
  assert.equal(samples[1].tMonotonicMs, 20);
  assert.deepEqual([samples[1].x, samples[1].y], [30, 90]);
  assert.equal(scheduled, null, 'stop() must clear the interval');
});

test('startNativeScreenCapture builds a real avfoundation ffmpeg command and stops gracefully with SIGINT then escalation', async () => {
  const killCalls = [];
  const proc = new EventEmitter();
  proc.kill = (signal) => killCalls.push(signal);
  const fakeSpawn = () => proc;

  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-cap-')), 'capture.mov');
  const session = startNativeScreenCapture({
    videoDeviceIndex: 1,
    audioDeviceIndex: 0,
    outputPath,
    fps: 30,
    ffmpegBinary: null,
    spawnImpl: fakeSpawn,
  });

  assert.ok(session.args.includes('avfoundation'));
  assert.ok(session.args.includes('1:0'));
  assert.ok(session.args.includes('-capture_cursor'));

  const stopPromise = session.stop({ escalateAfterMs: 20 });
  // Simulate ffmpeg exiting cleanly right after SIGINT, before escalation fires.
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(killCalls, ['SIGINT']);
  proc.emit('exit', 0);

  const result = await stopPromise;
  assert.equal(result.outputPath, outputPath);
});

test('startNativeScreenCapture escalates to SIGKILL if ffmpeg does not exit after SIGINT', async () => {
  const killCalls = [];
  const proc = new EventEmitter();
  proc.kill = (signal) => {
    killCalls.push(signal);
    if (signal === 'SIGKILL') setTimeout(() => proc.emit('exit', 137), 0);
  };
  const fakeSpawn = () => proc;

  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-cap-')), 'capture.mov');
  const session = startNativeScreenCapture({
    videoDeviceIndex: 0,
    outputPath,
    ffmpegBinary: null,
    spawnImpl: fakeSpawn,
  });

  await session.stop({ escalateAfterMs: 10 });
  assert.deepEqual(killCalls, ['SIGINT', 'SIGKILL']);
});

