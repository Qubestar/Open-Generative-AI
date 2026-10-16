import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  RendererAdapter,
  RENDERER_TYPES,
  resolveFfmpegBinary,
  resolveFfprobeBinary,
  MANAGED_FFMPEG_PACKAGES,
  downloadManagedFfmpegPackage,
  escapeFfmpegDrawtext,
  resolveCaptionFont,
  resolveChromeBinary,
  rasterizeCaptionPng,
} from '../src/rendererAdapter.js';
import { createEmptyEdg, createEdgTimeline } from '../src/edg.js';

test('managed binary metadata and resolver provide version, license and error handling', () => {
  assert.equal(MANAGED_FFMPEG_PACKAGES.version, '6.1.1');
  assert.equal(MANAGED_FFMPEG_PACKAGES.license, 'GPL-3.0');
  assert.ok(MANAGED_FFMPEG_PACKAGES.platforms['darwin-arm64']);
  assert.ok(MANAGED_FFMPEG_PACKAGES.platforms['win32-x64']);

  const binPath = resolveFfmpegBinary();
  assert.ok(fs.existsSync(binPath));

  assert.throws(
    () => resolveFfmpegBinary('/nonexistent/path/to/ffmpeg'),
    /FFmpeg binary not found/
  );
});

test('escapeFfmpegDrawtext escapes special characters and newlines', () => {
  const raw = "Special: 'quote' %percent% and \n newline with \\backslash";
  const escaped = escapeFfmpegDrawtext(raw);
  assert.ok(!escaped.includes('\n'));
  assert.ok(escaped.includes('\\:'));
  assert.ok(escaped.includes("'\\''"));
  assert.ok(escaped.includes('\\%'));
  assert.ok(escaped.includes('\\\\backslash'));
});

test('overlay caption plan generates correct overlay filter with enable expression and frame times', () => {
  const adapter = new RendererAdapter();
  adapter._availableFilters = new Set(['overlay']); // drawtext missing, overlay present
  const edg = createEmptyEdg({ aspect: '16:9' });
  const captionTrack = edg.tracks.find(t => t.type === 'caption');
  captionTrack.clips.push({
    id: 'cap_unit_01',
    text: 'Overlay Caption Unit Test',
    timelineStartFrame: 15, // 0.5s at 30fps
    timelineEndFrame: 45,   // 1.5s at 30fps
  });

  const outPath = path.join(os.tmpdir(), `test_overlay_plan_${Date.now()}.mp4`);
  const plan = adapter.buildFfmpegArguments(edg, outPath);

  assert.equal(plan.captions.status, 'applied');
  assert.equal(plan.captions.renderMode, 'overlay-png');
  assert.equal(plan.captions.requested, 1);
  assert.equal(plan.captions.applied, 1);
  assert.equal(plan.captions.skipped, 0);

  // Verify enable='between(t,start,end)' in filterComplex
  assert.match(plan.filterComplex, /overlay=0:0:enable='between\(t,0\.500,1\.500\)'/);
  // Verify inputs contain loop and framerate for the rasterized PNG
  const loopIdx = plan.args.indexOf('-loop');
  assert.ok(loopIdx !== -1, 'args must contain -loop for caption png');
  assert.equal(plan.args[loopIdx + 1], '1');

  // Clean up generated pngs
  if (plan.captions?._pngPaths) {
    for (const p of plan.captions._pngPaths) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
});

test('compareRenderPipelines checks timeline and dimensions alignment between ffmpeg and ffmpeg-simple metadata', async () => {
  const adapter = new RendererAdapter();
  const edg = createEmptyEdg({ aspect: '16:9' });
  const comparison = await adapter.compareRenderPipelines(edg);

  assert.equal(comparison.compatible, true);
  assert.equal(comparison.comparisonType, 'metadata_only');
  assert.equal(comparison.alignment.durationMatches, true);
  assert.equal(comparison.alignment.dimensionMatches, true);
  assert.equal(comparison.alignment.fpsMatches, true);
  assert.equal(comparison.alignment.ffmpeg.width, 1920);
  assert.equal(comparison.alignment.ffmpegSimple.width, 1920);
  assert.equal(comparison.hyperframesMigrationStatus, 'pinned');
});

test('buildFfmpegArguments creates valid command plan for 16:9, 9:16 and 1:1', () => {
  const adapter = new RendererAdapter();

  for (const aspect of ['16:9', '9:16', '1:1']) {
    const edg = createEmptyEdg({ aspect });
    const plan = adapter.buildFfmpegArguments(edg, `/tmp/test_${aspect.replace(':', '_')}.mp4`);
    assert.ok(plan.args.length > 5);
    assert.match(plan.filterComplex, /color=c=black/);
    if (aspect === '16:9') {
      assert.equal(plan.width, 1920);
      assert.equal(plan.height, 1080);
    } else if (aspect === '9:16') {
      assert.equal(plan.width, 1080);
      assert.equal(plan.height, 1920);
    } else if (aspect === '1:1') {
      assert.equal(plan.width, 1080);
      assert.equal(plan.height, 1080);
    }
  }
});

test('buildSceneConfig creates neutral scene config; buildHyperFramesConfig and buildFfmpegSimpleConfig wrap it', () => {
  const adapter = new RendererAdapter();
  const edg = createEmptyEdg({ aspect: '9:16' });

  const sceneConfig = adapter.buildSceneConfig(edg, '/tmp/scene_out.mp4');
  assert.equal(sceneConfig.aspect, '9:16');
  assert.equal(sceneConfig.resolution.width, 1080);
  assert.equal(sceneConfig.resolution.height, 1920);
  assert.equal(sceneConfig.engine, undefined);
  assert.equal(sceneConfig.version, undefined);
  assert.ok(Array.isArray(sceneConfig.layers));

  const hfConfig = adapter.buildHyperFramesConfig(edg, '/tmp/hf_out.mp4');
  assert.equal(hfConfig.engine, 'hyperframes');
  assert.equal(hfConfig.version, '0.8.72');
  assert.equal(hfConfig.migrationStatus, 'pinned');
  assert.equal(hfConfig.aspect, '9:16');

  const simpleConfig = adapter.buildFfmpegSimpleConfig(edg, '/tmp/simple_out.mp4');
  assert.equal(simpleConfig.engine, 'ffmpeg-simple');
  assert.equal(simpleConfig.version, '1.0.0');
  assert.equal(simpleConfig.aspect, '9:16');
});

test('renderExport supports tracking and cancellation', async () => {
  const adapter = new RendererAdapter();
  const edg = createEmptyEdg({ aspect: '16:9' });

  const result = await adapter.renderExport(edg, '/tmp/export.mp4');
  assert.equal(result.status, 'done');
  assert.ok(result.renderId);

  const tracker = adapter.getProgress(result.renderId);
  assert.equal(tracker.status, 'done');
  assert.equal(tracker.progress, 1.0);

  // Cancellation test
  const fakeJob = adapter.tracker.create({
    id: 'render_cancel_test',
    renderer: 'ffmpeg',
    outputPath: '/tmp/cancel.mp4',
    aspect: '16:9',
    targetResolution: '1920x1080',
  });
  fakeJob.status = 'rendering';
  const cancelled = adapter.cancel('render_cancel_test');
  assert.ok(cancelled);
  assert.equal(adapter.getProgress('render_cancel_test').status, 'cancelled');
});

test('real small FFmpeg export and ffprobe verification from EDG', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-real-export-'));
  const fixturePath = path.join(tmpDir, 'source_test.mp4');
  const exportPath = path.join(tmpDir, 'exported_output.mp4');

  // Generate a real 1-second sample video fixture with synthetic video (testsrc) and 48kHz audio (sine wave)
  const ffmpegBin = resolveFfmpegBinary();
  const genProc = spawnSync(ffmpegBin, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000',
    fixturePath,
  ], { encoding: 'utf8' });

  assert.equal(genProc.status, 0, `Failed to generate test fixture: ${genProc.stderr}`);
  assert.ok(fs.existsSync(fixturePath));

  const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');

  // Build an EDG referencing the source fixture
  const edg = createEdgTimeline({
    title: 'Real Export Test Session',
    aspect: '16:9',
    fps: 30,
    assets: {
      asset_src_01: {
        id: 'asset_src_01',
        path: fixturePath,
        hash: fixtureHash,
        type: 'video',
        durationSec: 1.0,
      },
    },
    tracks: [
      {
        id: 'track_v1',
        type: 'video',
        name: 'Main Video',
        clips: [
          {
            id: 'clip_v1',
            assetId: 'asset_src_01',
            sourceStartFrame: 0,
            sourceEndFrame: 30,
            timelineStartFrame: 0,
            timelineEndFrame: 30,
          },
        ],
      },
      {
        id: 'track_a1',
        type: 'audio',
        name: 'Main Audio',
        clips: [
          {
            id: 'clip_a1',
            assetId: 'asset_src_01',
            sourceStartFrame: 0,
            sourceEndFrame: 30,
            timelineStartFrame: 0,
            timelineEndFrame: 30,
          },
        ],
      },
      {
        id: 'track_c1',
        type: 'caption',
        name: 'Subtitles',
        clips: [
          {
            id: 'clip_c1',
            text: 'Vidmyo V2.6 Real Export',
            timelineStartFrame: 0,
            timelineEndFrame: 30,
          },
        ],
      },
    ],
  });

  const adapter = new RendererAdapter();
  const exportResult = await adapter.renderExport(edg, exportPath, {
    renderer: RENDERER_TYPES.FFMPEG,
    execute: true,
  });

  assert.equal(exportResult.status, 'done');
  assert.ok(fs.existsSync(exportPath));
  const exportStat = fs.statSync(exportPath);
  assert.ok(exportStat.size > 1000, `Export file size ${exportStat.size} is suspiciously small`);

  // Probe media using ffprobe
  const probeData = adapter.probeMedia(exportPath);
  assert.ok(probeData.streams && probeData.streams.length >= 1);

  const videoStream = probeData.streams.find(s => s.codec_type === 'video');
  const audioStream = probeData.streams.find(s => s.codec_type === 'audio');

  assert.ok(videoStream, 'Exported media must contain a video stream');
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(videoStream.width, 1920);
  assert.equal(videoStream.height, 1080);

  assert.ok(audioStream, 'Exported media must contain an audio stream');
  assert.equal(audioStream.codec_name, 'aac');
  assert.equal(audioStream.sample_rate, '48000');

  // Save probe artifact for EVIDENCE.md
  const evidenceDir = path.resolve('.tmp/vidmyo-v2.6');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'real_export_ffprobe.json'), JSON.stringify(probeData, null, 2));

  // Clean up fixture and export
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test('downloadManagedFfmpegPackage handles partial resume and verifies sha256 checksum', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-pkg-test-'));
  try {
    const fakeData = Buffer.from('Managed FFmpeg v6.1.1 test package binary payload with exact checksum bytes');
    const expectedSha = crypto.createHash('sha256').update(fakeData).digest('hex');

    // Override package checksum temporarily for test platform
    const platform = `${process.platform}-${process.arch}`;
    const origPkg = MANAGED_FFMPEG_PACKAGES.platforms[platform];
    MANAGED_FFMPEG_PACKAGES.platforms[platform] = {
      ...origPkg,
      filename: `ffmpeg-test-${platform}.zip`,
      sha256: expectedSha,
      downloadUrl: 'https://test.vidmyo.local/ffmpeg.zip',
    };

    let requestedRanges = [];
    const mockFetch = async (url, options) => {
      requestedRanges.push(options?.headers?.['Range'] || 'none');
      const range = options?.headers?.['Range'];
      if (range) {
        // Return 206 Partial Content
        const offset = parseInt(range.replace('bytes=', '').replace('-', ''), 10);
        const sliced = fakeData.subarray(offset);
        return {
          ok: true,
          status: 206,
          headers: { get: (h) => h.toLowerCase() === 'content-length' ? String(sliced.length) : null },
          arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => h.toLowerCase() === 'content-length' ? String(fakeData.length) : null },
        arrayBuffer: async () => fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength),
      };
    };

    // 1. First write a partial file to test resume
    const finalPath = path.join(tmpDir, `ffmpeg-test-${platform}.zip`);
    const partPath = `${finalPath}.part`;
    fs.writeFileSync(partPath, fakeData.subarray(0, 20));

    let progressEvents = [];
    const res = await downloadManagedFfmpegPackage({
      targetDir: tmpDir,
      platform,
      onProgress: (p) => progressEvents.push(p),
      fetchImpl: mockFetch,
    });

    assert.equal(res.verified, true);
    assert.equal(res.sha256, expectedSha);
    assert.ok(fs.existsSync(finalPath));
    assert.equal(requestedRanges[0], 'bytes=20-');
    assert.ok(progressEvents.length > 0);

    // Restore
    MANAGED_FFMPEG_PACKAGES.platforms[platform] = origPkg;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('renderExport executes real pixel renders for ffmpeg and ffmpeg-simple baselines across 9:16, 1:1, and 16:9', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-renders-'));
  try {
    const ffmpegBin = resolveFfmpegBinary();
    const adapter = new RendererAdapter();

    // Create a 1s fixture with image and audio
    const fixtureVideo = path.join(tmpDir, 'source_scene.mp4');
    const genProc = spawnSync(ffmpegBin, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000',
      fixtureVideo,
    ], { encoding: 'utf8' });
    assert.equal(genProc.status, 0);

    const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(fixtureVideo)).digest('hex');

    // Test across all 3 formats: 9:16, 1:1, 16:9
    const formats = [
      { aspect: '9:16', expectedW: 1080, expectedH: 1920 },
      { aspect: '1:1',  expectedW: 1080, expectedH: 1080 },
      { aspect: '16:9', expectedW: 1920, expectedH: 1080 },
    ];

    for (const fmt of formats) {
      const edg = createEdgTimeline({
        title: `Export ${fmt.aspect}`,
        aspect: fmt.aspect,
        fps: 30,
        assets: {
          asset_01: {
            id: 'asset_01',
            path: fixtureVideo,
            hash: fixtureHash,
            type: 'video',
            durationSec: 1.0,
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
                sourceEndFrame: 30,
                timelineStartFrame: 0,
                timelineEndFrame: 30,
                transform: { scale: 1.08, zoom: 1.08 },
              },
            ],
          },
          {
            id: 'audio-voice',
            type: 'audio',
            clips: [
              {
                id: 'voice_01',
                assetId: 'asset_01',
                sourceStartFrame: 0,
                sourceEndFrame: 30,
                timelineStartFrame: 0,
                timelineEndFrame: 30,
              },
            ],
          },
          {
            id: 'captions-main',
            type: 'caption',
            clips: [
              {
                id: 'cap_01',
                text: `Exporting ${fmt.aspect}`,
                timelineStartFrame: 0,
                timelineEndFrame: 30,
                transform: { y: fmt.expectedH - 150 },
              },
            ],
          },
        ],
      });

      const outA = path.join(tmpDir, `export_${fmt.aspect.replace(':', '_')}_ffmpeg.mp4`);
      const outB = path.join(tmpDir, `export_${fmt.aspect.replace(':', '_')}_simple.mp4`);

      const resA = await adapter.renderExport(edg, outA, {
        renderer: RENDERER_TYPES.FFMPEG,
        execute: true,
      });
      const resB = await adapter.renderExport(edg, outB, {
        renderer: RENDERER_TYPES.FFMPEG_SIMPLE,
        execute: true,
      });

      assert.equal(resA.status, 'done');
      assert.equal(resB.status, 'done');

      // Explicit captions status on REAL exports — the caption track is never
      // dropped silently. Three possible modes: drawtext, overlay-png, unavailable.
      for (const [label, res] of [['ffmpeg', resA], ['ffmpeg-simple', resB]]) {
        assert.ok(res.captions, `${label}: export result must carry an explicit captions status`);
        assert.ok(['applied', 'unavailable'].includes(res.captions.status), `${label}: captions.status=${res.captions.status}`);
        assert.ok(res.captions.requested >= 1, `${label}: caption clips requested`);
        if (res.captions.status === 'applied') {
          assert.ok(['drawtext', 'overlay-png'].includes(res.captions.renderMode), `${label}: renderMode=${res.captions.renderMode}`);
          assert.equal(res.captions.skipped, 0, `${label}: nothing skipped when applied`);
        } else {
          assert.equal(res.captions.skipped, res.captions.requested, `${label}: all requested captions reported skipped`);
          assert.equal(res.captions.applied, 0, `${label}: nothing applied`);
          assert.ok(res.captions.reason, `${label}: reason recorded`);
        }
      }

      const probeA = adapter.probeMedia(outA);
      const probeB = adapter.probeMedia(outB);

      const vA = probeA.streams.find(s => s.codec_type === 'video');
      const vB = probeB.streams.find(s => s.codec_type === 'video');

      assert.equal(vA?.width, fmt.expectedW);
      assert.equal(vA?.height, fmt.expectedH);
      assert.equal(vB?.width, fmt.expectedW);
      assert.equal(vB?.height, fmt.expectedH);

      // Check files exist and have non-zero size
      assert.ok(fs.existsSync(outA) && fs.statSync(outA).size > 1000);
      assert.ok(fs.existsSync(outB) && fs.statSync(outB).size > 1000);
      // Simplified stream manifest exists
      assert.ok(fs.existsSync(`${outB}.simple.json`));
    }

    // Phase 3 item 4: HYPERFRAMES without execute stays metadata-only…
    const edgSimple = createEmptyEdg({ aspect: '16:9' });
    const metaOnly = await adapter.renderExport(edgSimple, path.join(tmpDir, 'hf_meta.mp4'), {
      renderer: RENDERER_TYPES.HYPERFRAMES,
      execute: false,
    });
    assert.equal(metaOnly.status, 'config_only');
    assert.equal(metaOnly.migrationStatus, 'pinned');

    // …and with execute it converts the EDG. An EDG carrying a feature the
    // converter cannot represent fails closed in strict mode, listing every
    // unsupported feature instead of dropping it.
    const edgUnsupported = createEmptyEdg({ aspect: '16:9' });
    edgUnsupported.totalTimelineFrames = 30;
    edgUnsupported.tracks.find((t) => t.id === 'overlay-broll').clips.push({
      id: 'speedlines_1',
      type: 'speedlines',
      timelineStartFrame: 0,
      timelineEndFrame: 30,
    });
    await assert.rejects(
      () => adapter.renderExport(edgUnsupported, path.join(tmpDir, 'hf_blocked.mp4'), {
        renderer: RENDERER_TYPES.HYPERFRAMES,
        execute: true,
        strictEdg: true,
        keepProject: true,
      }),
      (err) => {
        assert.equal(err.code, 'EDG_UNSUPPORTED');
        assert.ok(Array.isArray(err.unsupported) && err.unsupported.length > 0);
        assert.match(err.message, /overlay-effect:speedlines/);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('renderer reports captions status explicitly instead of dropping them silently', async () => {
  const buildCaptionEdg = () => {
    const edg = createEmptyEdg({ aspect: '16:9' });
    const captionTrack = edg.tracks.find(t => t.type === 'caption');
    captionTrack.clips.push({
      id: 'cap_01',
      text: 'Explicit caption status',
      timelineStartFrame: 0,
      timelineEndFrame: 30,
    });
    return edg;
  };

  // (a) drawtext available → captions applied via drawtext in the filtergraph.
  const adapterWithDrawtext = new RendererAdapter();
  adapterWithDrawtext._availableFilters = new Set(['drawtext']);
  const planApplied = adapterWithDrawtext.buildFfmpegArguments(buildCaptionEdg(), '/tmp/captions_applied.mp4');
  assert.equal(planApplied.captions.status, 'applied');
  assert.equal(planApplied.captions.renderMode, 'drawtext');
  assert.equal(planApplied.captions.requested, 1);
  assert.equal(planApplied.captions.applied, 1);
  assert.equal(planApplied.captions.skipped, 0);
  assert.match(planApplied.filterComplex, /drawtext=/);

  const appliedResult = await adapterWithDrawtext.renderExport(buildCaptionEdg(), '/tmp/captions_applied.mp4');
  assert.equal(appliedResult.captions.status, 'applied');

  // (b) Neither drawtext nor overlay → fully unavailable with exact reasons.
  const adapterNone = new RendererAdapter();
  adapterNone._availableFilters = new Set();
  const planBlocked = adapterNone.buildFfmpegArguments(buildCaptionEdg(), '/tmp/captions_blocked.mp4');
  assert.equal(planBlocked.captions.status, 'unavailable');
  assert.equal(planBlocked.captions.renderMode, null);
  assert.equal(planBlocked.captions.requested, 1);
  assert.equal(planBlocked.captions.applied, 0);
  assert.equal(planBlocked.captions.skipped, 1);
  assert.match(planBlocked.captions.reason, /lacks the 'drawtext' filter/);
  assert.match(planBlocked.captions.reason, /lacks the 'overlay' filter/);
  assert.ok(!planBlocked.filterComplex.includes('drawtext='), 'no drawtext filter');
  assert.ok(!planBlocked.filterComplex.includes('overlay='), 'no overlay filter');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let blockedResult;
  try {
    blockedResult = await adapterNone.renderExport(buildCaptionEdg(), '/tmp/captions_blocked.mp4');
    const simpleResult = await adapterNone.renderExport(buildCaptionEdg(), '/tmp/captions_blocked_simple.mp4', {
      renderer: RENDERER_TYPES.FFMPEG_SIMPLE,
    });
    assert.equal(simpleResult.captions.status, 'unavailable');
    assert.match(simpleResult.captions.reason, /lacks the 'drawtext' filter/);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(blockedResult.captions.status, 'unavailable');
  assert.equal(blockedResult.plan.captions.status, 'unavailable');
  assert.equal(warnings.length, 2, 'both real export paths warn when captions are skipped');
  assert.ok(warnings.every(w => w.includes("lacks the 'drawtext' filter")));

  // (c) EDG without captions → status 'none', no warning.
  const emptyPlan = adapterNone.buildFfmpegArguments(createEmptyEdg({ aspect: '16:9' }), '/tmp/no_caps.mp4');
  assert.equal(emptyPlan.captions.status, 'none');
  assert.equal(emptyPlan.captions.renderMode, null);
  assert.equal(emptyPlan.captions.requested, 0);
  assert.equal(emptyPlan.captions.skipped, 0);

  // (d) overlay-png fallback: drawtext missing but overlay + Chrome available.
  const adapterOverlay = new RendererAdapter();
  adapterOverlay._availableFilters = new Set(['overlay']);
  const chromeBin = resolveChromeBinary();
  if (chromeBin) {
    const plan = adapterOverlay.captionPlan(2, {
      drawtextAvailable: false,
      overlayAvailable: true,
      chromeAvailable: true,
    });
    assert.equal(plan.status, 'applied');
    assert.equal(plan.renderMode, 'overlay-png');
    assert.equal(plan.applied, 2);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.reason, null);
  }
});
