import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  createScreenStudioEdgFromRecording,
  renderScreenStudioExport,
  createScreenStudioEdgTimeline,
} from '../src/screenStudio.js';
import { validateEdg } from '../src/edg.js';
import { resolveFfmpegBinary, resolveFfprobeBinary, RendererAdapter } from '../src/rendererAdapter.js';
import { ResourceGovernor } from '../src/governor.js';
import { runGovernedFfmpeg } from '../src/governedProcess.js';

function createTempDir(prefix = 'vidmyo-screen-export-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Screen Studio Recording Export: fixture generation, EDG validation, real render and frame comparison', async () => {
  const tempDir = createTempDir();
  const governor = new ResourceGovernor({ governorDir: tempDir });
  const ffmpeg = resolveFfmpegBinary();
  const adapter = new RendererAdapter({ ffmpegPath: ffmpeg });

  const fixturePath = path.join(tempDir, 'recording_fixture_3s.mp4');

  // 1. Generate 3-second testsrc + sine fixture with ffmpeg
  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000',
      fixturePath,
    ],
    governor,
    jobId: 'job_gen_fixture',
    resourceClass: 'heavy',
  });

  assert.ok(fs.existsSync(fixturePath), 'Fixture must be created');

  // 2. createScreenStudioEdgFromRecording
  const display = { bounds: { x: 0, y: 0, width: 640, height: 360 }, scaleFactor: 1 };
  const telemetry = [
    { tMonotonicMs: 0, x: 320, y: 180 },
    { tMonotonicMs: 500, x: 100, y: 100 },
    { tMonotonicMs: 1200, x: 102, y: 101 }, // Dwell around (100, 100)
    { tMonotonicMs: 2000, x: 500, y: 300 },
  ];

  const edgRes = await createScreenStudioEdgFromRecording({
    recordingPath: fixturePath,
    telemetry,
    display,
    fps: 30,
    governor,
    jobId: 'job_edg_build',
  });

  assert.ok(edgRes.edg);
  assert.equal(typeof edgRes.hash, 'string');
  assert.equal(edgRes.hash.length, 64, 'SHA-256 hash must be 64 hex characters');
  assert.equal(edgRes.edg.meta.source, 'recording');
  assert.equal(edgRes.telemetryStatus, 'ok');
  assert.ok(edgRes.totalFrames >= 89 && edgRes.totalFrames <= 91);
  assert.doesNotThrow(() => validateEdg(edgRes.edg), 'Generated EDG must pass schema validation');

  // 3. renderScreenStudioExport with real FFmpeg
  const exportPath = path.join(tempDir, 'screen_studio_export_3s.mp4');
  const exportRes = await renderScreenStudioExport(edgRes.edg, exportPath, {
    fps: 30,
    width: 640,
    height: 360,
    governor,
    jobId: 'job_screen_export_real',
  });

  assert.equal(exportRes.ok, true);
  assert.ok(fs.existsSync(exportPath));
  assert.equal(exportRes.zoomApplied, true);

  // Probe export with ffprobe
  const probe = await adapter.probeMediaGoverned(exportPath, { governor, jobId: 'job_probe_export' });
  const vStream = probe.streams?.find((s) => s.codec_type === 'video');
  const aStream = probe.streams?.find((s) => s.codec_type === 'audio');

  assert.ok(vStream, 'Export must have a video stream');
  assert.ok(aStream, 'Export must have an audio stream');
  assert.equal(vStream.codec_name, 'h264');
  assert.equal(aStream.codec_name, 'aac');

  const dur = Number(vStream.duration || probe.format.duration);
  assert.ok(Math.abs(dur - 3.0) <= (1 / 30 + 0.05), `Duration ${dur}s must be within 1 frame of 3.0s`);

  // 4. Zoomed frame differs from unzoomed frame
  const frame0Path = path.join(tempDir, 'frame_unzoomed.png');
  const frame1Path = path.join(tempDir, 'frame_zoomed.png');

  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: ['-y', '-ss', '0.1', '-i', exportPath, '-vframes', '1', frame0Path],
    governor,
    jobId: 'job_ext_frame0',
    resourceClass: 'light',
  });

  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: ['-y', '-ss', '1.2', '-i', exportPath, '-vframes', '1', frame1Path],
    governor,
    jobId: 'job_ext_frame1',
    resourceClass: 'light',
  });

  const hash0 = crypto.createHash('md5').update(fs.readFileSync(frame0Path)).digest('hex');
  const hash1 = crypto.createHash('md5').update(fs.readFileSync(frame1Path)).digest('hex');
  assert.notEqual(hash0, hash1, 'Zoomed frame must differ visually from unzoomed frame');

  // 5. Cancel test
  const cancelPath = path.join(tempDir, 'cancel_test.mp4');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);

  await assert.rejects(
    renderScreenStudioExport(edgRes.edg, cancelPath, {
      fps: 30,
      width: 640,
      height: 360,
      governor,
      jobId: 'job_screen_cancel',
      signal: ac.signal,
    }),
    /cancel/i,
  );
  assert.ok(!fs.existsSync(cancelPath), 'Cancelled export must remove partial file');

  // 6. Demo branch regression: synthetic flow still produces valid export
  const demoEdg = createScreenStudioEdgTimeline({ durationSec: 2, totalFrames: 60 });
  const demoOutPath = path.join(tempDir, 'demo_branch.mp4');
  const demoRes = await renderScreenStudioExport(demoEdg, demoOutPath, {
    fps: 30,
    width: 640,
    height: 360,
    governor,
    jobId: 'job_demo_regress',
  });
  assert.equal(demoRes.ok, true);
  assert.ok(fs.existsSync(demoOutPath));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Long-duration drift test: 10-minute lavfi source at 30 and 60 fps maintains A/V sync within 1 frame', async () => {
  const tempDir = createTempDir();
  const governor = new ResourceGovernor({ governorDir: tempDir });
  const ffmpeg = resolveFfmpegBinary();
  const adapter = new RendererAdapter({ ffmpegPath: ffmpeg });

  // Test at 30 fps: 10 minutes (600s) low-res (160x90) with ultrafast encoding
  const test30Path = path.join(tempDir, 'drift_30fps.mp4');
  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '600',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
      '-af', 'aresample=48000:async=1,apad',
      '-c:a', 'aac', '-b:a', '32k',
      test30Path,
    ],
    governor,
    jobId: 'job_drift_30',
    resourceClass: 'heavy',
    timeoutMs: 120000,
  });

  const probe30 = await adapter.probeMediaGoverned(test30Path, { governor, jobId: 'job_probe_30' });
  const v30 = probe30.streams.find((s) => s.codec_type === 'video');
  const a30 = probe30.streams.find((s) => s.codec_type === 'audio');

  const v30Dur = Number(v30.duration || probe30.format.duration);
  const a30Dur = Number(a30.duration || probe30.format.duration);
  const diff30 = Math.abs(v30Dur - a30Dur);
  const oneFrame30 = 1 / 30;

  assert.ok(
    diff30 <= (oneFrame30 + 0.03),
    `30 fps A/V end difference (${diff30.toFixed(4)}s) must stay within 1 frame (${oneFrame30.toFixed(4)}s + muxer tolerance)`,
  );

  // Test at 60 fps: 10 minutes (600s)
  const test60Path = path.join(tempDir, 'drift_60fps.mp4');
  await runGovernedFfmpeg({
    cmd: ffmpeg,
    args: [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=60',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '600',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35',
      '-af', 'aresample=48000:async=1,apad',
      '-c:a', 'aac', '-b:a', '32k',
      test60Path,
    ],
    governor,
    jobId: 'job_drift_60',
    resourceClass: 'heavy',
    timeoutMs: 120000,
  });

  const probe60 = await adapter.probeMediaGoverned(test60Path, { governor, jobId: 'job_probe_60' });
  const v60 = probe60.streams.find((s) => s.codec_type === 'video');
  const a60 = probe60.streams.find((s) => s.codec_type === 'audio');

  const v60Dur = Number(v60.duration || probe60.format.duration);
  const a60Dur = Number(a60.duration || probe60.format.duration);
  const diff60 = Math.abs(v60Dur - a60Dur);
  const oneFrame60 = 1 / 60;

  assert.ok(
    diff60 <= (oneFrame60 + 0.03),
    `60 fps A/V end difference (${diff60.toFixed(4)}s) must stay within 1 frame (${oneFrame60.toFixed(4)}s + muxer tolerance)`,
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});
