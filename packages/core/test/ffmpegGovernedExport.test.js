import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  runGovernedFfmpeg,
  ResourceGovernor,
  RESOURCE_CLASSES,
  resolveFfmpegBinary,
  renderScreenStudioExport,
  createStudioCanvasConfig,
  createScreenStudioEdgTimeline,
} from '../index.js';
import { RendererAdapter } from '../src/rendererAdapter.js';
import { createEdgTimeline } from '../src/edg.js';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pgrepGroup(pgid) {
  if (!pgid) return { code: 1, out: '' };
  try {
    const res = spawnSync('/usr/bin/pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
    return { code: res.status, out: (res.stdout || '').trim() };
  } catch {
    return { code: 1, out: '' };
  }
}

test('runGovernedFfmpeg with pre-aborted signal fails immediately with ECANCELLED and acquires no lease', async () => {
  const governorDir = tempDir('vidmyo-gov-preabort-');
  const governor = new ResourceGovernor({ governorDir });
  const ffmpeg = resolveFfmpegBinary();

  const controller = new AbortController();
  controller.abort();

  const jobId = `job_preabort_${Date.now()}`;
  await assert.rejects(
    async () => {
      await runGovernedFfmpeg({
        cmd: ffmpeg,
        args: ['-f', 'lavfi', '-i', 'nullsrc', '-t', '1', '-f', 'null', '-'],
        signal: controller.signal,
        governor,
        jobId,
      });
    },
    (err) => {
      assert.equal(err.code, 'ECANCELLED');
      assert.equal(err.spawned, false);
      return true;
    }
  );

  // Heavy slot should be completely free
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be immediately free');
  governor.release(lease.token);
});

test('runGovernedFfmpeg timeoutMs aborts process group, sets ETIMEDOUT and frees governor heavy lease', async () => {
  const governorDir = tempDir('vidmyo-gov-timeout-');
  const governor = new ResourceGovernor({ governorDir });
  const ffmpeg = resolveFfmpegBinary();

  const jobId = `job_timeout_${Date.now()}`;
  const start = Date.now();

  let capturedPid = null;
  await assert.rejects(
    async () => {
      await runGovernedFfmpeg({
        cmd: ffmpeg,
        args: [
          '-re',
          '-f', 'lavfi',
          '-i', 'testsrc=size=320x240:rate=30',
          '-t', '10',
          '-f', 'null',
          '-',
        ],
        governor,
        jobId,
        timeoutMs: 800,
        onSpawn: (cp) => {
          capturedPid = cp.pid;
        },
      });
    },
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      return true;
    }
  );

  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 700 && elapsed <= 5000, `Elapsed time ${elapsed}ms should be around 800ms`);

  // Verify child process and its entire process group are dead
  if (capturedPid) {
    await sleep(150);
    assert.equal(alive(capturedPid), false, `PID ${capturedPid} must be terminated`);
    const pg = pgrepGroup(capturedPid);
    assert.equal(pg.out, '', `Process group ${capturedPid} must have no survivors (got: ${pg.out})`);
  }

  // Governor lease must be released
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be free after timeout');
  governor.release(lease.token);
});

test('runGovernedFfmpeg signal abort terminates child process, sets ECANCELLED and releases governor lease', async () => {
  const governorDir = tempDir('vidmyo-gov-signal-');
  const governor = new ResourceGovernor({ governorDir });
  const ffmpeg = resolveFfmpegBinary();

  const controller = new AbortController();
  const jobId = `job_abort_${Date.now()}`;

  let capturedPid = null;
  const runPromise = runGovernedFfmpeg({
    cmd: ffmpeg,
    args: [
      '-re',
      '-f', 'lavfi',
      '-i', 'testsrc=size=320x240:rate=30',
      '-t', '15',
      '-f', 'null',
      '-',
    ],
    signal: controller.signal,
    governor,
    jobId,
    onSpawn: (cp) => {
      capturedPid = cp.pid;
    },
  });

  // Wait until process is running
  await sleep(100);
  assert.ok(capturedPid && alive(capturedPid), 'Process should be alive before abort');

  controller.abort();

  await assert.rejects(
    runPromise,
    (err) => {
      assert.equal(err.code, 'ECANCELLED');
      return true;
    }
  );

  await sleep(150);
  assert.equal(alive(capturedPid), false, `PID ${capturedPid} must be dead after abort`);
  const pg = pgrepGroup(capturedPid);
  assert.equal(pg.out, '', `Process group ${capturedPid} must have no survivors (got: ${pg.out})`);

  // Governor lease must be free
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be free after abort');
  governor.release(lease.token);
});

test('renderScreenStudioExport abort releases governor lease and cleans up output file', async () => {
  const governorDir = tempDir('vidmyo-screen-abort-');
  const governor = new ResourceGovernor({ governorDir });
  const workDir = tempDir('vidmyo-screen-out-');
  const outputPath = path.join(workDir, 'cancelled_export.mp4');

  const canvas = createStudioCanvasConfig();
  const session = {
    mouseMovements: [{ time: 0, x: 100, y: 100 }, { time: 5, x: 200, y: 200 }],
    clicks: [],
    durationSec: 5,
  };
  const edg = createScreenStudioEdgTimeline(session, [], canvas, { aspect: '16:9', fps: 30 });

  const controller = new AbortController();
  const jobId = `job_screen_${Date.now()}`;

  const renderPromise = renderScreenStudioExport(edg, outputPath, {
    fps: 30,
    width: 640,
    height: 360,
    governor,
    jobId,
    signal: controller.signal,
  });

  await sleep(100);
  controller.abort();

  await assert.rejects(
    renderPromise,
    (err) => {
      assert.equal(err.code, 'ECANCELLED');
      return true;
    }
  );

  // Partial file must be unlinked
  assert.equal(fs.existsSync(outputPath), false, 'Cancelled output file must not be left on disk');

  // Governor lease must be free
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be free after cancelled screen export');
  governor.release(lease.token);
});

test('RendererAdapter.renderExport with cancel(renderId) sets cancelled status, frees lease, and unlinks partial file', async () => {
  const governorDir = tempDir('vidmyo-render-cancel-gov-');
  const governor = new ResourceGovernor({ governorDir });
  const workDir = tempDir('vidmyo-render-cancel-out-');
  const outputPath = path.join(workDir, 'cancelled_render.mp4');
  const ffmpegBin = resolveFfmpegBinary();

  // Create 5s fixture video
  const fixtureVideo = path.join(workDir, 'source_scene.mp4');
  const genProc = spawnSync(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000',
    fixtureVideo,
  ], { encoding: 'utf8' });
  assert.equal(genProc.status, 0);

  const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(fixtureVideo)).digest('hex');

  const edg = createEdgTimeline({
    title: 'Cancel Render Test',
    aspect: '16:9',
    fps: 30,
    assets: {
      asset_01: {
        id: 'asset_01',
        path: fixtureVideo,
        hash: fixtureHash,
        type: 'video',
        durationSec: 5.0,
      },
    },
    tracks: [
      {
        id: 'video-primary',
        type: 'video',
        clips: [
          {
            id: 'clip_01',
            assetId: 'asset_01',
            sourceStartFrame: 0,
            sourceEndFrame: 150,
            timelineStartFrame: 0,
            timelineEndFrame: 150,
          },
        ],
      },
    ],
  });

  const adapter = new RendererAdapter();
  const renderId = `render_test_cancel_${Date.now()}`;

  const renderPromise = adapter.renderExport(edg, outputPath, {
    renderId,
    execute: true,
    governor,
    renderer: 'ffmpeg',
  });

  await sleep(150);

  // Verify job is running
  const progressBefore = adapter.getProgress(renderId);
  assert.ok(progressBefore, 'Job must be tracked before cancel');

  // Cancel via adapter.cancel(renderId)
  const cancelled = adapter.cancel(renderId);
  assert.equal(cancelled, true, 'adapter.cancel must return true for active job');

  await assert.rejects(
    renderPromise,
    (err) => {
      assert.ok(
        err.code === 'ECANCELLED' || /cancel/i.test(err.message),
        `Error must indicate cancellation (got: ${err.message})`
      );
      return true;
    }
  );

  // Job status in tracker must be 'cancelled'
  const progressAfter = adapter.getProgress(renderId);
  assert.equal(progressAfter.status, 'cancelled', 'Job status must be cancelled in tracker');

  // Partial file must be unlinked
  assert.equal(fs.existsSync(outputPath), false, 'Cancelled output file must not be left on disk');

  // Governor lease must be free
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be free after cancelled renderExport');
  governor.release(lease.token);
});

test('RendererAdapter.renderExport with timeoutMs aborts export, cleans up file and frees lease', async () => {
  const governorDir = tempDir('vidmyo-render-timeout-gov-');
  const governor = new ResourceGovernor({ governorDir });
  const workDir = tempDir('vidmyo-render-timeout-out-');
  const outputPath = path.join(workDir, 'timeout_render.mp4');
  const ffmpegBin = resolveFfmpegBinary();

  // Create 10s fixture video
  const fixtureVideo = path.join(workDir, 'source_scene_long.mp4');
  const genProc = spawnSync(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000',
    fixtureVideo,
  ], { encoding: 'utf8' });
  assert.equal(genProc.status, 0);

  const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(fixtureVideo)).digest('hex');

  const edg = createEdgTimeline({
    title: 'Timeout Render Test',
    aspect: '16:9',
    fps: 30,
    assets: {
      asset_01: {
        id: 'asset_01',
        path: fixtureVideo,
        hash: fixtureHash,
        type: 'video',
        durationSec: 10.0,
      },
    },
    tracks: [
      {
        id: 'video-primary',
        type: 'video',
        clips: [
          {
            id: 'clip_01',
            assetId: 'asset_01',
            sourceStartFrame: 0,
            sourceEndFrame: 300,
            timelineStartFrame: 0,
            timelineEndFrame: 300,
          },
        ],
      },
    ],
  });

  const adapter = new RendererAdapter();
  const renderId = `render_test_timeout_${Date.now()}`;

  await assert.rejects(
    adapter.renderExport(edg, outputPath, {
      renderId,
      execute: true,
      governor,
      renderer: 'ffmpeg',
      timeoutMs: 300,
    }),
    (err) => {
      assert.ok(
        err.code === 'ETIMEDOUT' || /timed?\s*out/i.test(err.message),
        `Error must indicate timeout (got: ${err.message})`
      );
      return true;
    }
  );

  // Partial file must not exist
  assert.equal(fs.existsSync(outputPath), false, 'Timed-out output file must be cleaned up');

  // Governor lease must be free
  const lease = governor.acquire({
    jobId: `probe_${Date.now()}`,
    resourceClass: RESOURCE_CLASSES.HEAVY,
  });
  assert.ok(lease.token, 'Governor heavy slot must be free after timed-out renderExport');
  governor.release(lease.token);
});
