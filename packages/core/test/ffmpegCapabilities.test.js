// Phase 3, item 3 — FFmpeg capability detection (P11, no new binary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';
import { createEdgTimeline } from '../src/edg.js';

import {
  probeFfmpegCapabilities,
  tryProbeFfmpegCapabilities,
  classifyFfmpegLicense,
  parseFfmpegFilters,
  parseFfmpegVersionOutput,
  parseFfmpegEncoders,
  selectH264Encoder,
  H264_ENCODER_UNAVAILABLE,
  H264EncoderUnavailableError,
  FfmpegMissingError,
  FFMPEG_MISSING,
} from '../src/ffmpegCapabilities.js';
import {
  RendererAdapter,
  escapeFfmpegFilterPath,
  buildAssSubtitleFile,
  resolveFfmpegBinary,
  resolveFfprobeBinary,
} from '../src/rendererAdapter.js';

const EVIDENCE_PATH = fileURLToPath(new URL('../../../.tmp/vidmyo-v2.6/ffmpeg-capabilities.json', import.meta.url));

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function fakeBinary(root, name) {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\nexit 0\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function stubSpawn({ version, filters, encoders = '' }) {
  return (bin, args) => {
    if (args[0] === '-version') return { status: 0, stdout: version, stderr: '', error: null };
    if (args[0] === '-filters') return { status: 0, stdout: filters, stderr: '', error: null };
    if (args.includes('-encoders')) return { status: 0, stdout: encoders, stderr: '', error: null };
    return { status: 1, stdout: '', stderr: 'unexpected', error: null };
  };
}

const FULL_VERSION = [
  'ffmpeg version 7.0-full_build Copyright (c) 2000-2026 the FFmpeg developers',
  'built with gcc 13',
  'configuration: --prefix=/opt --enable-gpl --enable-version3 --enable-libass --enable-libx264 --enable-libfreetype',
  'libavutil      59. 12.100 / 59. 12.100',
].join('\n');

const FULL_FILTERS = [
  'Filters:',
  '  T.. = Timeline support',
  ' T.C drawtext        VV->V      Draw text on top of video frames',
  ' ..C subtitles       V->V       Render text subtitle onto input video',
  ' ..C ass             V->V       Render ASS subtitle onto input video',
  ' TS  overlay         VV->V      Overlay a video source on top of the input.',
].join('\n');

const NO_DRAWTEXT_VERSION = [
  'ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers',
  'configuration: --prefix=/opt/homebrew/Cellar/ffmpeg/8.1.1 --enable-gpl --enable-version3 --enable-libsvtav1 --enable-libx264',
].join('\n');

const NO_DRAWTEXT_FILTERS = [
  'Filters:',
  '  T.. = Timeline support',
  ' TS  overlay         VV->V      Overlay a video source on top of the input.',
  ' T.. scale            V->V       Scale the input video size and/or convert.',
].join('\n');

const LGPL_VERSION = [
  'ffmpeg version 6.1 Copyright (c) 2000-2026 the FFmpeg developers',
  'configuration: --prefix=/usr --enable-version3 --enable-libopus',
].join('\n');

test('probeFfmpegCapabilities reports path, source, version, licence class and caption filters', () => {
  const root = tempDir('vidmyo-ffcap-full-');
  try {
    const bin = fakeBinary(root, 'ffmpeg-full');
    const report = probeFfmpegCapabilities({
      ffmpegPath: bin,
      spawnSyncImpl: stubSpawn({ version: FULL_VERSION, filters: FULL_FILTERS }),
      forceRefresh: true,
    });
    assert.equal(report.path, path.resolve(bin));
    assert.equal(report.source, 'custom');
    assert.equal(report.version, '7.0-full_build');
    assert.deepEqual(report.filters, { drawtext: true, subtitles: true, ass: true, overlay: true });
    assert.equal(report.libass, true);
    assert.ok(report.configuration.includes('--enable-gpl'));
    assert.equal(report.licenseClass, 'GPL-3.0-or-later');
    assert.ok(report.availableFilters.includes('drawtext'));
    // Legend lines must not be read as filters.
    assert.ok(!report.availableFilters.includes('Timeline'));
    assert.ok(!report.availableFilters.includes('support'));
    assert.ok(report.probedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeFfmpegCapabilities classifies an LGPL build without libass', () => {
  const root = tempDir('vidmyo-ffcap-lgpl-');
  try {
    const bin = fakeBinary(root, 'ffmpeg-lgpl');
    const report = probeFfmpegCapabilities({
      ffmpegPath: bin,
      spawnSyncImpl: stubSpawn({ version: LGPL_VERSION, filters: 'Filters:\n TS  overlay  VV->V  desc\n' }),
      forceRefresh: true,
    });
    assert.equal(report.licenseClass, 'LGPL-3.0-or-later');
    assert.equal(report.libass, false);
    assert.equal(report.filters.drawtext, false);
    assert.equal(report.filters.overlay, true);
    assert.equal(report.source, 'custom');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a build without drawtext keeps overlay and reports drawtext absent', () => {
  const root = tempDir('vidmyo-ffcap-nodraw-');
  try {
    const bin = fakeBinary(root, 'ffmpeg-nodraw');
    const report = probeFfmpegCapabilities({
      ffmpegPath: bin,
      spawnSyncImpl: stubSpawn({ version: NO_DRAWTEXT_VERSION, filters: NO_DRAWTEXT_FILTERS }),
      forceRefresh: true,
    });
    assert.equal(report.filters.drawtext, false);
    assert.equal(report.filters.overlay, true);
    assert.equal(report.libass, false);
    assert.equal(report.licenseClass, 'GPL-3.0-or-later');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing binary raises the typed FFMPEG_MISSING error with actionable hints', () => {
  const missing = path.join(os.tmpdir(), `vidmyo-no-such-ffmpeg-${Date.now()}`);
  assert.throws(
    () => probeFfmpegCapabilities({ ffmpegPath: missing }),
    (err) => {
      assert.ok(err instanceof FfmpegMissingError);
      assert.equal(err.code, FFMPEG_MISSING);
      assert.match(err.message, /brew install ffmpeg/);
      assert.match(err.message, /VIDMYO_FFMPEG_PATH/);
      assert.ok(err.hints.includes('brew install ffmpeg'));
      return true;
    },
  );

  const probe = tryProbeFfmpegCapabilities({ ffmpegPath: missing });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, FFMPEG_MISSING);
  assert.match(probe.error, /brew install ffmpeg/);

  assert.throws(() => probeFfmpegCapabilities({ ffmpegPath: null }), FfmpegMissingError);
});

test('capability probe is cached per path+mtime and can be forced', () => {
  const root = tempDir('vidmyo-ffcap-cache-');
  try {
    const bin = fakeBinary(root, 'ffmpeg-cache');
    let calls = 0;
    const impl = (...args) => { calls += 1; return stubSpawn({ version: LGPL_VERSION, filters: 'Filters:\n TS  overlay  VV->V  d\n' })(...args); };
    const first = probeFfmpegCapabilities({ ffmpegPath: bin, spawnSyncImpl: impl, forceRefresh: true });
    const second = probeFfmpegCapabilities({ ffmpegPath: bin, spawnSyncImpl: impl });
    assert.equal(calls, 3, 'cached second read must not spawn again');
    assert.deepEqual(second, first);
    probeFfmpegCapabilities({ ffmpegPath: bin, spawnSyncImpl: impl, forceRefresh: true });
    assert.equal(calls, 6, 'forceRefresh must spawn again');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RendererAdapter.captionPlan picks drawtext -> libass -> overlay-png -> unavailable, with reasons', () => {
  const adapter = Object.create(RendererAdapter.prototype);

  const viaDrawtext = adapter.captionPlan(2, { drawtextAvailable: true, libassAvailable: true, overlayAvailable: true, chromeAvailable: true });
  assert.equal(viaDrawtext.renderMode, 'drawtext');
  assert.equal(viaDrawtext.status, 'applied');

  const viaLibass = adapter.captionPlan(2, { drawtextAvailable: false, libassAvailable: true, overlayAvailable: true, chromeAvailable: true });
  assert.equal(viaLibass.renderMode, 'libass');
  assert.equal(viaLibass.status, 'applied');

  const viaOverlay = adapter.captionPlan(2, { drawtextAvailable: false, libassAvailable: false, overlayAvailable: true, chromeAvailable: true });
  assert.equal(viaOverlay.renderMode, 'overlay-png');
  assert.equal(viaOverlay.status, 'applied');

  const nothing = adapter.captionPlan(2, { drawtextAvailable: false, libassAvailable: false, overlayAvailable: false, chromeAvailable: false });
  assert.equal(nothing.status, 'unavailable');
  assert.equal(nothing.renderMode, null);
  assert.equal(nothing.applied, 0);
  assert.equal(nothing.skipped, 2);
  assert.match(nothing.reason, /drawtext/);
  assert.match(nothing.reason, /libass/);
  assert.match(nothing.reason, /overlay/);
  assert.match(nothing.reason, /Chrome/);
  assert.match(nothing.reason, /NO burned-in captions/);

  const none = adapter.captionPlan(0, {});
  assert.equal(none.status, 'none');
});

test('RendererAdapter.hasFilter/libassAvailable follow the capability report', () => {
  const root = tempDir('vidmyo-ffcap-adapter-');
  try {
    const full = fakeBinary(root, 'ffmpeg-full');
    const noDraw = fakeBinary(root, 'ffmpeg-nodraw');
    const stubFull = stubSpawn({ version: FULL_VERSION, filters: FULL_FILTERS });
    const stubNoDraw = stubSpawn({ version: NO_DRAWTEXT_VERSION, filters: NO_DRAWTEXT_FILTERS });

    const fullAdapter = new RendererAdapter({ ffmpegPath: full, probeSpawnSync: stubFull });
    assert.equal(fullAdapter.hasFilter('drawtext'), true);
    assert.equal(fullAdapter.hasFilter('overlay'), true);
    assert.equal(fullAdapter.libassAvailable(), true);
    assert.equal(fullAdapter.capabilities().licenseClass, 'GPL-3.0-or-later');

    const noDrawAdapter = new RendererAdapter({ ffmpegPath: noDraw, probeSpawnSync: stubNoDraw });
    assert.equal(noDrawAdapter.hasFilter('drawtext'), false);
    assert.equal(noDrawAdapter.hasFilter('overlay'), true);
    assert.equal(noDrawAdapter.libassAvailable(), false);

    const missing = new RendererAdapter({ ffmpegPath: path.join(root, 'not-here') });
    assert.equal(missing.hasFilter('drawtext'), false);
    assert.equal(missing.libassAvailable(), false);
    assert.equal(missing.capabilities(), null);
    assert.equal(missing.capabilitiesError().code, FFMPEG_MISSING);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('escapeFfmpegFilterPath quotes the path so filter syntax inside it stays literal', () => {
  assert.equal(escapeFfmpegFilterPath('/tmp/plain.ass'), "'/tmp/plain.ass'");
  assert.equal(escapeFfmpegFilterPath("/tmp/it's.ass"), "'/tmp/it\\'s.ass'");
  assert.equal(escapeFfmpegFilterPath('/tmp/a[b].ass'), "'/tmp/a[b].ass'");
  assert.equal(escapeFfmpegFilterPath('/tmp/a:b,c;d.ass'), "'/tmp/a:b,c;d.ass'");
  assert.equal(escapeFfmpegFilterPath('/tmp/back\\slash.ass'), "'/tmp/back\\\\slash.ass'");
});

test('buildAssSubtitleFile emits absolute frame-derived times and escapes text', () => {
  const ass = buildAssSubtitleFile([
    { text: 'Hello {world}', startSec: 1 / 30, endSec: 2 },
    { text: 'Line\nbreak', startSec: 3661.5, endSec: 3662 },
    { text: '', startSec: 0, endSec: 1 },
  ], { width: 1080, height: 1920 });

  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /\[Events\]/);
  // 1/30 s at 30 fps must land exactly on frame 1 — no summed durations.
  assert.match(ass, /Dialogue: 0,0:00:00\.03,0:00:02\.00,Default,,0,0,0,,Hello \\\{world\\\}/);
  assert.match(ass, /Dialogue: 0,1:01:01\.50,1:01:02\.00,Default,,0,0,0,,Line\\Nbreak/);
  assert.equal((ass.match(/Dialogue:/g) || []).length, 2, 'empty captions are dropped');
});

test('real local FFmpeg capability probe is recorded as evidence', () => {
  const report = probeFfmpegCapabilities({ ffmpegPath: resolveFfmpegBinary(), forceRefresh: true });
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(report, null, 2));
  assert.ok(report.version, 'a real probe must report a version');
  assert.ok(report.licenseClass);
  assert.ok(Array.isArray(report.availableFilters) && report.availableFilters.length > 0);
  // This machine's build is expected to be the drawtext-less Homebrew one;
  // record the fact rather than assume it.
  assert.equal(typeof report.filters.drawtext, 'boolean');
  assert.equal(typeof report.libass, 'boolean');
  // No binary was downloaded or bundled by this probe.
  assert.ok(fs.existsSync(report.path));
});

test('parseFfmpegEncoders parses encoder names from ffmpeg -encoders output', () => {
  const sample = `
Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 ------
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V..... h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V..... hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 A..... aac                  AAC (Advanced Audio Coding)
 A..... libmp3lame           libmp3lame MP3 (MPEG audio layer 3)
`;
  const parsed = parseFfmpegEncoders(sample);
  assert.ok(parsed.has('libx264'));
  assert.ok(parsed.has('h264_videotoolbox'));
  assert.ok(parsed.has('hevc_videotoolbox'));
  assert.ok(parsed.has('aac'));
  assert.ok(!parsed.has('Encoders:'));
  assert.ok(!parsed.has('Video'));
});

test('selectH264Encoder selector selects encoder according to platform and capabilities', () => {
  // 1. libx264 only
  const reportLibx264 = {
    encoders: { libx264: true, h264_videotoolbox: false, aac: true },
    availableEncoders: ['libx264', 'aac'],
  };
  const sel1 = selectH264Encoder(reportLibx264, { platform: 'darwin', isPreview: false });
  assert.equal(sel1.name, 'libx264');
  assert.equal(sel1.reason, 'default-software-encoder');
  assert.deepEqual(sel1.args, ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']);

  const sel1Prev = selectH264Encoder(reportLibx264, { platform: 'darwin', isPreview: true });
  assert.deepEqual(sel1Prev.args, ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p']);

  const sel1Custom = selectH264Encoder(reportLibx264, { platform: 'darwin', crf: 23 });
  assert.deepEqual(sel1Custom.args, ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p']);

  // 2. VT only on darwin
  const reportVT = {
    encoders: { libx264: false, h264_videotoolbox: true, aac: true },
    availableEncoders: ['h264_videotoolbox', 'aac'],
  };
  const sel2 = selectH264Encoder(reportVT, { platform: 'darwin', height: 720 });
  assert.equal(sel2.name, 'h264_videotoolbox');
  assert.equal(sel2.reason, 'videotoolbox-hardware-fallback');
  assert.deepEqual(sel2.args, ['-c:v', 'h264_videotoolbox', '-b:v', '2M', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);

  const sel21080 = selectH264Encoder(reportVT, { platform: 'darwin', height: 1080 });
  assert.deepEqual(sel21080.args, ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);

  const sel24k = selectH264Encoder(reportVT, { platform: 'darwin', height: 2160 });
  assert.deepEqual(sel24k.args, ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-profile:v', 'high', '-pix_fmt', 'yuv420p']);

  // 3. neither on darwin -> throws
  const reportNone = {
    encoders: { libx264: false, h264_videotoolbox: false, aac: true },
    availableEncoders: ['aac'],
  };
  assert.throws(
    () => selectH264Encoder(reportNone, { platform: 'darwin' }),
    H264EncoderUnavailableError,
  );

  // 4. VT only on linux -> throws (VT is darwin-only)
  assert.throws(
    () => selectH264Encoder(reportVT, { platform: 'linux' }),
    H264EncoderUnavailableError,
  );

  // 5. Override tests
  const reportBoth = {
    encoders: { libx264: true, h264_videotoolbox: true, aac: true },
    availableEncoders: ['libx264', 'h264_videotoolbox', 'aac'],
  };
  const selOv1 = selectH264Encoder(reportBoth, { override: 'h264_videotoolbox', platform: 'darwin' });
  assert.equal(selOv1.name, 'h264_videotoolbox');
  assert.equal(selOv1.reason, 'override');

  const selOv2 = selectH264Encoder(reportBoth, { override: 'libx264', platform: 'darwin' });
  assert.equal(selOv2.name, 'libx264');
  assert.equal(selOv2.reason, 'override');

  assert.throws(
    () => selectH264Encoder(reportBoth, { override: 'unknown_enc' }),
    H264EncoderUnavailableError,
  );
});

test('real short exports for libx264 and h264_videotoolbox verified with ffprobe', async () => {
  const ffmpeg = resolveFfmpegBinary();
  const ffprobe = resolveFfprobeBinary();
  const report = probeFfmpegCapabilities({ ffmpegPath: ffmpeg });
  const root = tempDir('vidmyo-real-encoders-');

  // Verify availability on this platform (no silent skip)
  assert.ok(report.encoders?.libx264, 'libx264 encoder must be available in system FFmpeg on this machine');
  if (process.platform === 'darwin') {
    assert.ok(report.encoders?.h264_videotoolbox, 'h264_videotoolbox encoder must be available on macOS');
  }

  try {
    const fixtureVideo = path.join(root, 'source_scene.mp4');
    const genProc = spawnSync(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000',
      fixtureVideo,
    ], { encoding: 'utf8' });
    assert.equal(genProc.status, 0, `fixture generation failed: ${genProc.stderr}`);

    const fixtureHash = crypto.createHash('sha256').update(fs.readFileSync(fixtureVideo)).digest('hex');

    const edg = createEdgTimeline({
      title: 'Real Encoder Export Test',
      aspect: '16:9',
      fps: 30,
      assets: {
        asset_01: {
          id: 'asset_01',
          path: fixtureVideo,
          hash: fixtureHash,
          type: 'video',
          durationSec: 2.0,
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
              sourceEndFrame: 60,
              timelineStartFrame: 0,
              timelineEndFrame: 60,
            },
          ],
        },
      ],
    });

    const adapter = new RendererAdapter({ ffmpegPath: ffmpeg, ffprobePath: ffprobe });

    // 1. libx264 export through RendererAdapter.renderExport
    const outPathLibx264 = path.join(root, 'adapter_libx264.mp4');
    const resLibx264 = await adapter.renderExport(edg, outPathLibx264, {
      execute: true,
      encoderOverride: 'libx264',
      renderer: 'ffmpeg',
    });

    assert.equal(resLibx264.status, 'done');
    assert.ok(resLibx264.encoder, 'Result must contain encoder selection');
    assert.equal(resLibx264.encoder.name, 'libx264');
    assert.ok(fs.existsSync(outPathLibx264));

    const probeRes1 = spawnSync(ffprobe, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      outPathLibx264,
    ], { encoding: 'utf8' });
    assert.equal(probeRes1.status, 0);
    const meta1 = JSON.parse(probeRes1.stdout);
    const vStream1 = meta1.streams.find((s) => s.codec_type === 'video');
    assert.ok(vStream1, 'video stream must exist in libx264 export');
    assert.equal(vStream1.codec_name, 'h264');
    const dur1 = parseFloat(meta1.format.duration);
    assert.ok(Math.abs(dur1 - 2.0) <= (1 / 30 + 0.02), `duration ${dur1} within 1 frame + 0.02s`);

    // 2. h264_videotoolbox export through RendererAdapter.renderExport
    if (process.platform === 'darwin') {
      const outPathVT = path.join(root, 'adapter_videotoolbox.mp4');
      const resVT = await adapter.renderExport(edg, outPathVT, {
        execute: true,
        encoderOverride: 'h264_videotoolbox',
        renderer: 'ffmpeg',
      });

      assert.equal(resVT.status, 'done');
      assert.ok(resVT.encoder, 'Result must contain encoder selection');
      assert.equal(resVT.encoder.name, 'h264_videotoolbox');
      assert.ok(fs.existsSync(outPathVT));

      const probeRes2 = spawnSync(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        outPathVT,
      ], { encoding: 'utf8' });
      assert.equal(probeRes2.status, 0);
      const meta2 = JSON.parse(probeRes2.stdout);
      const vStream2 = meta2.streams.find((s) => s.codec_type === 'video');
      assert.ok(vStream2, 'video stream must exist in VideoToolbox export');
      assert.equal(vStream2.codec_name, 'h264');
      const dur2 = parseFloat(meta2.format.duration);
      assert.ok(Math.abs(dur2 - 2.0) <= (1 / 30 + 0.02), `duration ${dur2} within 1 frame + 0.02s`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

