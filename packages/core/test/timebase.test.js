import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFps,
  rationalToNumber,
  secondsToFrame,
  frameToSeconds,
  secondsToSamples,
  samplesToSeconds,
  frameToSamples,
  samplesToFrame,
  calculateAbsoluteBoundaries,
  mapPtsToOutputFrames,
  verifyTimelineDrift,
  STANDARD_FPS,
} from '../src/timebase.js';

test('parseFps handles numbers and rational objects correctly', () => {
  assert.deepEqual(parseFps(30), { num: 30, den: 1 });
  assert.deepEqual(parseFps(60), { num: 60, den: 1 });
  assert.deepEqual(parseFps({ num: 24000, den: 1001 }), { num: 24000, den: 1001 });
  assert.deepEqual(parseFps(23.976), { num: 24000, den: 1001 });
  assert.equal(rationalToNumber(STANDARD_FPS.FPS_30), 30);
  assert.throws(() => parseFps(-1));
  assert.throws(() => parseFps({ num: 0, den: 1 }));
});

test('secondsToFrame and frameToSeconds conversions are reversible', () => {
  const fps = STANDARD_FPS.FPS_30;
  assert.equal(secondsToFrame(0, fps), 0);
  assert.equal(secondsToFrame(1.0, fps), 30);
  assert.equal(secondsToFrame(2.5, fps), 75);
  assert.equal(frameToSeconds(75, fps), 2.5);

  const ntsc = STANDARD_FPS.NTSC_24;
  const frame = secondsToFrame(10.0, ntsc);
  assert.equal(typeof frame, 'number');
  assert.ok(frame > 230 && frame < 250);
});

test('audio sample conversions match 48000 Hz standard', () => {
  assert.equal(secondsToSamples(1.0, 48000), 48000);
  assert.equal(samplesToSeconds(48000, 48000), 1.0);
  assert.equal(secondsToSamples(0.5, 48000), 24000);
  assert.equal(samplesToSeconds(24000, 48000), 0.5);

  const sampleAtFrame30 = frameToSamples(30, STANDARD_FPS.FPS_30, 48000);
  assert.equal(sampleAtFrame30, 48000);
  assert.equal(samplesToFrame(48000, 48000, STANDARD_FPS.FPS_30), 30);
});

test('calculateAbsoluteBoundaries prevents rounding gap errors', () => {
  const segments = [
    { durationSec: 1.333 },
    { durationSec: 2.333 },
    { durationSec: 0.667 },
  ];
  const boundaries = calculateAbsoluteBoundaries(segments, STANDARD_FPS.FPS_30);
  assert.equal(boundaries.length, 3);

  // Each segment begins exactly where previous ended
  assert.equal(boundaries[0].startFrame, 0);
  assert.equal(boundaries[1].startFrame, boundaries[0].endFrame);
  assert.equal(boundaries[2].startFrame, boundaries[1].endFrame);

  // Sum of individual durationFrames equals final endFrame
  const totalDuration = boundaries.reduce((acc, b) => acc + b.durationFrames, 0);
  assert.equal(totalDuration, boundaries[2].endFrame);
});

test('mapPtsToOutputFrames maps VFR timestamps cleanly to target grid', () => {
  const pts = [0.0, 0.033, 0.068, 0.099, 0.134];
  const mapped = mapPtsToOutputFrames(pts, STANDARD_FPS.FPS_30);
  assert.equal(mapped.length, 5);
  assert.equal(mapped[0].outputFrame, 0);
  assert.equal(mapped[1].outputFrame, 1);
  assert.equal(mapped[4].outputFrame, 4);
});

test('30-minute timeline verification proves ZERO cumulative drift', () => {
  const result = verifyTimelineDrift(1800, [2.35, 4.12, 1.83, 5.07, 3.44], STANDARD_FPS.FPS_30, 48000);
  assert.ok(result.passed, 'Timeline drift test must pass');
  assert.equal(result.frameDriftAtEnd, 0, 'Frame drift at 30 mins must be exactly 0 frames');
  assert.ok(result.maxAudioVideoSyncErrorFrames <= 1, 'Max A/V sync error must be <= 1 frame');
  assert.ok(result.segmentCount > 400, 'Test must cover over 400 cuts');
});

test('deterministic 30-minute VFR fixture exports at 30 and 60 fps with A/V sync error <= 1 frame', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { RendererAdapter, RENDERER_TYPES, resolveFfmpegBinary, resolveFfprobeBinary } = await import('../src/rendererAdapter.js');
  const { createEdgTimeline } = await import('../src/edg.js');

  const ffmpegBin = resolveFfmpegBinary();
  const ffprobeBin = resolveFfprobeBinary();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-30m-vfr-'));
  const vfrFixturePath = path.join(tmpDir, 'vfr_30min_fixture.mp4');

  try {
    // 1. Generate deterministic 30-minute (1800s) VFR fixture at 64x36 with synchronized video flashes & audio tone beeps
    // Video: 64x36 black background, white flash every 1s (mod(t,1) < 0.05) matching audio beep, with VFR timestamp jitter (sin(N))
    // Audio: 48 kHz sine wave (1000 Hz) with periodic beep every 1s (mod(t,1) < 0.05), silent elsewhere
    const genProc = spawnSync(ffmpegBin, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=64x36:d=1800:r=60,drawbox=x=0:y=0:w=64:h=36:color=white:t=fill:enable=\'lt(mod(t,1),0.05)\',select=\'not(eq(mod(n\\,5)\\,0))\'',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:duration=1800:sample_rate=48000,volume=0:enable=\'gte(mod(t,1),0.05)\'',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-fps_mode', 'vfr',
      '-c:a', 'aac',
      '-ar', '48000',
      vfrFixturePath,
    ], { encoding: 'utf8' });

    assert.equal(genProc.status, 0, `Failed to generate 30-minute VFR fixture: ${genProc.stderr}`);
    assert.ok(fs.existsSync(vfrFixturePath));

    // 2. Assert that fixture really is VFR (frame intervals are not constant)
    const vfrProbeProc = spawnSync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-read_intervals', '%+2', // first 2 seconds of packets
      '-of', 'json',
      vfrFixturePath,
    ], { encoding: 'utf8' });
    assert.equal(vfrProbeProc.status, 0, `ffprobe failed on VFR fixture: ${vfrProbeProc.stderr}`);
    const vfrPackets = JSON.parse(vfrProbeProc.stdout).packets || [];
    assert.ok(vfrPackets.length >= 20, 'Fixture must have sufficient packets to inspect intervals');
    const intervals = [];
    for (let i = 1; i < vfrPackets.length; i++) {
      const dt = parseFloat(vfrPackets[i].pts_time) - parseFloat(vfrPackets[i - 1].pts_time);
      intervals.push(parseFloat(dt.toFixed(4)));
    }
    const uniqueIntervals = new Set(intervals);
    assert.ok(uniqueIntervals.size > 1, `Fixture must be genuinely VFR with non-constant frame intervals; unique intervals: ${Array.from(uniqueIntervals).slice(0, 5)}`);

    const crypto = await import('node:crypto');
    const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(vfrFixturePath)).digest('hex');

    const adapter = new RendererAdapter({ ffmpegPath: ffmpegBin, ffprobePath: ffprobeBin });

    // Test both 30 fps and 60 fps exports routed through Vidmyo's RendererAdapter and EDG timeline
    for (const targetFps of [30, 60]) {
      const exportPath = path.join(tmpDir, `export_${targetFps}fps.mp4`);
      const totalFrames = 1800 * targetFps;

      const edg = createEdgTimeline({
        title: `30-minute VFR test ${targetFps}fps`,
        aspect: '16:9',
        fps: targetFps,
        canvas: { width: 64, height: 36, aspect: '16:9' },
        assets: {
          vfr_src: {
            id: 'vfr_src',
            path: vfrFixturePath,
            hash: fixtureHash,
            type: 'video',
            durationSec: 1800.0,
          },
        },
        tracks: [
          {
            id: 'v-main',
            type: 'video',
            clips: [
              {
                id: 'clip-v',
                assetId: 'vfr_src',
                sourceStartFrame: 0,
                sourceEndFrame: totalFrames,
                timelineStartFrame: 0,
                timelineEndFrame: totalFrames,
              },
            ],
          },
          {
            id: 'a-main',
            type: 'audio',
            clips: [
              {
                id: 'clip-a',
                assetId: 'vfr_src',
                sourceStartFrame: 0,
                sourceEndFrame: totalFrames,
                timelineStartFrame: 0,
                timelineEndFrame: totalFrames,
              },
            ],
          },
        ],
      });

      // Route export through Vidmyo's RendererAdapter with CFR normalization and 48kHz audio resample
      const renderResult = await adapter.renderExport(edg, exportPath, {
        renderer: RENDERER_TYPES.FFMPEG,
        execute: true,
        isPreview: true, // uses ultrafast preset
        targetFps,
      });

      assert.equal(renderResult.status, 'done', `RendererAdapter failed at ${targetFps} fps`);
      assert.ok(fs.existsSync(exportPath));

      // Inspect streams and total PTS duration via ffprobe
      const probeProc = spawnSync(ffprobeBin, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,duration,r_frame_rate,nb_frames:format=duration',
        '-of', 'json',
        exportPath,
      ], { encoding: 'utf8' });

      assert.equal(probeProc.status, 0, `ffprobe failed: ${probeProc.stderr}`);
      const probeInfo = JSON.parse(probeProc.stdout);

      const vStream = probeInfo.streams.find(s => s.codec_type === 'video');
      const aStream = probeInfo.streams.find(s => s.codec_type === 'audio');
      assert.ok(vStream, 'Export must have a video stream');
      assert.ok(aStream, 'Export must have an audio stream');

      const vDuration = parseFloat(vStream.duration || probeInfo.format.duration);
      const aDuration = parseFloat(aStream.duration || probeInfo.format.duration);

      // Verify total duration is ~1800.0s (30 minutes)
      assert.ok(Math.abs(vDuration - 1800.0) < 0.5, `Video duration ${vDuration}s must be ~1800.0s at ${targetFps} fps`);
      assert.ok(Math.abs(aDuration - 1800.0) < 0.5, `Audio duration ${aDuration}s must be ~1800.0s at ${targetFps} fps`);

      // Verify A/V sync error <= 1 frame duration (1 / targetFps), strictly without extra tolerance
      const maxAllowedAvDriftSec = 1.0 / targetFps;
      const actualAvDriftSec = Math.abs(vDuration - aDuration);
      assert.ok(
        actualAvDriftSec <= maxAllowedAvDriftSec,
        `A/V total duration drift ${actualAvDriftSec.toFixed(5)}s must be <= 1 frame (${maxAllowedAvDriftSec.toFixed(5)}s) at ${targetFps} fps`
      );

      // 3. Inspect deterministic marker onsets (flash onset vs. beep onset) at start, middle, and end
      const checkPointsSec = [2.0, 900.0, 1798.0];
      for (const cp of checkPointsSec) {
        // Find video flash onset using showinfo to detect luma step
        const vProbe = spawnSync(ffmpegBin, [
          '-ss', String(Math.max(0, cp - 0.2)),
          '-t', '0.5',
          '-copyts',
          '-i', exportPath,
          '-vf', 'showinfo',
          '-f', 'null',
          '-',
        ], { encoding: 'utf8' });
        assert.equal(vProbe.status, 0, `ffmpeg showinfo failed at ${cp}s: ${vProbe.stderr}`);

        let flashOnset = null;
        for (const line of (vProbe.stderr || '').split('\n')) {
          const m = line.match(/pts_time:([0-9.]+).*mean:\[([0-9]+)/);
          if (m) {
            const pts = parseFloat(m[1]);
            const luma = parseInt(m[2], 10);
            if (pts >= cp - 0.1 && luma > 100) {
              flashOnset = pts;
              break;
            }
          }
        }
        assert.ok(flashOnset !== null, `Failed to locate white flash onset near checkpoint ${cp}s`);

        // Find audio beep onset using silencedetect (or astats fallback)
        const aProbe = spawnSync(ffmpegBin, [
          '-ss', String(Math.max(0, cp - 0.25)),
          '-t', '0.5',
          '-copyts',
          '-i', exportPath,
          '-af', 'silencedetect=noise=-30dB:d=0.03',
          '-f', 'null',
          '-',
        ], { encoding: 'utf8' });
        assert.equal(aProbe.status, 0, `ffmpeg silencedetect failed at ${cp}s: ${aProbe.stderr}`);

        let beepOnset = null;
        for (const line of (aProbe.stderr || '').split('\n')) {
          const m = line.match(/silence_end:\s*([0-9.]+)/);
          if (m) {
            const pts = parseFloat(m[1]);
            if (pts >= cp - 0.1 && pts <= cp + 0.1) {
              beepOnset = pts;
              break;
            }
          }
        }

        if (beepOnset === null) {
          const astatsProbe = spawnSync(ffmpegBin, [
            '-ss', String(Math.max(0, cp - 0.2)),
            '-t', '0.4',
            '-copyts',
            '-i', exportPath,
            '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
            '-f', 'null',
            '-',
          ], { encoding: 'utf8' });
          let curPts = null;
          for (const line of (astatsProbe.stderr || '').split('\n')) {
            const ptsM = line.match(/pts_time:([0-9.]+)/);
            if (ptsM) curPts = parseFloat(ptsM[1]);
            const rmsM = line.match(/lavfi\.astats\.Overall\.RMS_level=([0-9.-]+)/);
            if (rmsM && curPts !== null && curPts >= cp - 0.1) {
              const rms = parseFloat(rmsM[1]);
              if (rms > -25) {
                beepOnset = curPts;
                break;
              }
            }
          }
        }
        assert.ok(beepOnset !== null, `Failed to locate audio beep onset near checkpoint ${cp}s`);

        const markerDrift = Math.abs(flashOnset - beepOnset);
        assert.ok(
          markerDrift <= maxAllowedAvDriftSec,
          `At ${cp}s checkpoint: flash onset (${flashOnset.toFixed(5)}s) and beep onset (${beepOnset.toFixed(5)}s) drift ${markerDrift.toFixed(5)}s must be <= 1 frame (${maxAllowedAvDriftSec.toFixed(5)}s) at ${targetFps} fps`
        );
      }

      // Clean up export file immediately to keep temporary disk usage minimal
      try { fs.unlinkSync(exportPath); } catch {}
    }
  } finally {
    // Delete all temporary files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});



