// Runtime FFmpeg capability report (Phase 3, item 3 / P11).
//
// NOTHING here downloads, bundles or installs a binary. The report answers
// one question honestly: which FFmpeg are we actually talking to, what licence
// class does that build declare, and which caption-relevant filters does it
// really have? Renderers pick the caption path from this report instead of
// assuming `drawtext` / `libass` exist.
//
// Licence classes are derived from the build's own `configuration:` line —
// they describe what the binary declares, not a legal opinion.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const FFMPEG_MISSING = 'FFMPEG_MISSING';
export const FFMPEG_PROBE_FAILED = 'FFMPEG_PROBE_FAILED';

export const CAPTION_FILTERS = ['drawtext', 'subtitles', 'ass', 'overlay'];

const probeCache = new Map(); // `${resolved}|${mtimeMs}|${size}` -> report

export class FfmpegMissingError extends Error {
  constructor(ffmpegPath, cause = null) {
    super(
      `FFmpeg binary not found${ffmpegPath ? ` at ${ffmpegPath}` : ''}. `
      + 'Install it with `brew install ffmpeg`, or point VIDMYO_FFMPEG_PATH at an existing binary. '
      + 'Vidmyo never downloads or bundles an FFmpeg build.',
    );
    this.name = 'FfmpegMissingError';
    this.code = FFMPEG_MISSING;
    this.ffmpegPath = ffmpegPath || null;
    this.hints = ['brew install ffmpeg', 'VIDMYO_FFMPEG_PATH=/path/to/ffmpeg'];
    if (cause) this.cause = cause;
  }
}

export class FfmpegProbeError extends Error {
  constructor(ffmpegPath, detail) {
    super(`FFmpeg capability probe failed for ${ffmpegPath}: ${detail}`);
    this.name = 'FfmpegProbeError';
    this.code = FFMPEG_PROBE_FAILED;
    this.ffmpegPath = ffmpegPath;
  }
}

function classifySource(resolvedPath) {
  const envPath = process.env.VIDMYO_FFMPEG_PATH;
  if (envPath && path.resolve(envPath) === resolvedPath) return 'env';
  if (resolvedPath.includes(`${path.sep}ffmpeg-static${path.sep}`)) return 'ffmpeg-static';
  if (resolvedPath.includes(`${path.sep}.runtime${path.sep}`)) return 'bundled-runtime';
  if (resolvedPath.startsWith('/opt/homebrew/') || resolvedPath.startsWith('/usr/local/')) return 'system';
  if (resolvedPath.startsWith('/usr/bin/')) return 'system';
  return 'custom';
}

/**
 * FFmpeg's own licence knob:
 *   --enable-gpl      -> GPL (2+ , or 3+ together with --enable-version3)
 *   --enable-version3 -> LGPL/GPL v3
 *   --enable-nonfree  -> non-redistributable
 *   otherwise         -> LGPL 2.1+ (FFmpeg's default)
 */
export function classifyFfmpegLicense(configuration = []) {
  const cfg = Array.isArray(configuration) ? configuration.join(' ') : String(configuration || '');
  const gpl = /(?:^|\s)--enable-gpl(?:\s|$)/.test(cfg);
  const version3 = /(?:^|\s)--enable-version3(?:\s|$)/.test(cfg);
  const nonfree = /(?:^|\s)--enable-nonfree(?:\s|$)/.test(cfg);
  if (nonfree) return { licenseClass: 'nonfree', redistributable: false };
  if (gpl && version3) return { licenseClass: 'GPL-3.0-or-later', redistributable: true, copyleft: true };
  if (gpl) return { licenseClass: 'GPL-2.0-or-later', redistributable: true, copyleft: true };
  if (version3) return { licenseClass: 'LGPL-3.0-or-later', redistributable: true, copyleft: true };
  return { licenseClass: 'LGPL-2.1-or-later', redistributable: true, copyleft: true };
}

// Parses `ffmpeg -filters`: `  TS overlay           VV->V      description`.
// The trailing `->` requirement keeps the legend lines (`T.. = Timeline
// support`) from being read as filters.
export function parseFfmpegFilters(stdout = '') {
  const names = new Set();
  for (const line of String(stdout).split('\n')) {
    const match = line.match(/^\s*([A-Za-z.]{1,6})\s+([A-Za-z0-9_]+)\s+.*->/);
    if (match) names.add(match[2]);
  }
  return names;
}

export function parseFfmpegVersionOutput(stdout = '') {
  const text = String(stdout);
  const versionMatch = text.match(/ffmpeg version\s+(\S+)/);
  const configurationMatch = text.match(/configuration:\s*(.*)/);
  const configuration = configurationMatch
    ? configurationMatch[1].trim().split(/\s+/).filter(Boolean)
    : [];
  return {
    version: versionMatch ? versionMatch[1] : null,
    versionLine: versionMatch ? versionMatch[0] : null,
    configuration,
    libass: configuration.some((flag) => flag === '--enable-libass'),
  };
}

/**
 * Probe ONE ffmpeg binary. Never throws anything other than the typed errors
 * above; result is cached per (path, mtime, size).
 *
 * @returns {{
 *   path: string, source: string, version: string|null, configuration: string[],
 *   licenseClass: string, redistributable: boolean, copyleft: boolean,
 *   filters: { drawtext: boolean, subtitles: boolean, ass: boolean, overlay: boolean },
 *   availableFilters: string[], libass: boolean, probedAt: string
 * }}
 */
export function probeFfmpegCapabilities({
  ffmpegPath,
  spawnSyncImpl = spawnSync,
  forceRefresh = false,
} = {}) {
  if (!ffmpegPath) throw new FfmpegMissingError(null);

  const resolved = path.resolve(ffmpegPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new FfmpegMissingError(resolved, err);
  }
  if (!stat.isFile()) throw new FfmpegMissingError(resolved);

  const key = `${resolved}|${stat.mtimeMs}|${stat.size}`;
  if (!forceRefresh && probeCache.has(key)) return probeCache.get(key);

  const versionProc = (() => {
    try {
      return spawnSyncImpl(resolved, ['-version'], { encoding: 'utf8', timeout: 15000 });
    } catch (err) {
      throw new FfmpegMissingError(resolved, err);
    }
  })();
  if (versionProc && versionProc.error) throw new FfmpegMissingError(resolved, versionProc.error);
  if (!versionProc || versionProc.status !== 0) {
    throw new FfmpegProbeError(resolved, `exit ${versionProc ? versionProc.status : 'null'}: ${(versionProc && versionProc.stderr || '').slice(-300)}`);
  }

  const parsed = parseFfmpegVersionOutput(versionProc.stdout || '');
  const filtersProc = (() => {
    try {
      return spawnSyncImpl(resolved, ['-filters'], { encoding: 'utf8', timeout: 15000 });
    } catch {
      return null;
    }
  })();
  const availableFilters = filtersProc && filtersProc.status === 0
    ? [...parseFfmpegFilters(filtersProc.stdout || '')]
    : [];
  const available = new Set(availableFilters);

  const encodersProc = (() => {
    try {
      return spawnSyncImpl(resolved, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
    } catch {
      return null;
    }
  })();
  const availableEncoders = encodersProc && encodersProc.status === 0
    ? [...parseFfmpegEncoders(encodersProc.stdout || '')]
    : [];
  const encoderSet = new Set(availableEncoders);

  const license = classifyFfmpegLicense(parsed.configuration);

  const report = {
    path: resolved,
    source: classifySource(resolved),
    version: parsed.version,
    versionLine: parsed.versionLine,
    configuration: parsed.configuration,
    licenseClass: license.licenseClass,
    redistributable: license.redistributable,
    copyleft: Boolean(license.copyleft),
    filters: {
      drawtext: available.has('drawtext'),
      subtitles: available.has('subtitles'),
      ass: available.has('ass'),
      overlay: available.has('overlay'),
    },
    availableFilters,
    encoders: {
      libx264: encoderSet.has('libx264'),
      h264_videotoolbox: encoderSet.has('h264_videotoolbox'),
      aac: encoderSet.has('aac'),
    },
    availableEncoders,
    // libass is a *build* flag; `subtitles`/`ass` are the runtime filters it
    // provides. Both are reported so a renderer never guesses.
    libass: parsed.libass && (available.has('subtitles') || available.has('ass')),
    probedAt: new Date().toISOString(),
  };

  probeCache.set(key, report);
  return report;
}

export const H264_ENCODER_UNAVAILABLE = 'H264_ENCODER_UNAVAILABLE';

export class H264EncoderUnavailableError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'H264EncoderUnavailableError';
    this.code = H264_ENCODER_UNAVAILABLE;
    this.hints = hints;
  }
}

// Parses `ffmpeg -encoders`: ` V..... libx264              libx264 H.264 / AVC...`
export function parseFfmpegEncoders(stdout = '') {
  const names = new Set();
  for (const line of String(stdout).split('\n')) {
    const match = line.match(/^\s*([A-Za-z.]{6})\s+([A-Za-z0-9_]+)/);
    if (match) names.add(match[2]);
  }
  return names;
}

/**
 * Selects an H.264 encoder based on runtime FFmpeg capability report.
 *   - libx264: software encoding (preserves -preset / -crf).
 *   - h264_videotoolbox: hardware encoding on darwin (-b:v 2M/6M/12M, -profile:v high, -pix_fmt yuv420p).
 *   - otherwise throws typed H264EncoderUnavailableError.
 */
export function selectH264Encoder(report, {
  platform = process.platform,
  isPreview = false,
  height = 720,
  override = null,
  crf = null,
  realtime = false,
} = {}) {
  const available = new Set(report?.availableEncoders || []);
  if (report?.encoders) {
    if (report.encoders.libx264) available.add('libx264');
    if (report.encoders.h264_videotoolbox) available.add('h264_videotoolbox');
  }

  let chosen = null;
  let reason = null;

  if (override) {
    if (override === 'libx264') {
      if (!available.has('libx264')) {
        throw new H264EncoderUnavailableError(
          'Requested H.264 encoder "libx264" is not available in the detected FFmpeg build.',
          ['brew install ffmpeg', 'VIDMYO_FFMPEG_PATH=/path/to/ffmpeg'],
        );
      }
      chosen = 'libx264';
      reason = 'override';
    } else if (override === 'h264_videotoolbox') {
      if (platform !== 'darwin' || !available.has('h264_videotoolbox')) {
        throw new H264EncoderUnavailableError(
          'Requested H.264 encoder "h264_videotoolbox" is only available on macOS with VideoToolbox support.',
          ['Run on macOS or configure libx264'],
        );
      }
      chosen = 'h264_videotoolbox';
      reason = 'override';
    } else {
      throw new H264EncoderUnavailableError(
        `Unsupported encoder override: ${override}`,
        ['Use "libx264" or "h264_videotoolbox"'],
      );
    }
  } else if (realtime && platform === 'darwin' && available.has('h264_videotoolbox')) {
    chosen = 'h264_videotoolbox';
    reason = 'videotoolbox-realtime-hardware';
  } else if (available.has('libx264')) {
    chosen = 'libx264';
    reason = realtime ? 'libx264-realtime-software' : 'default-software-encoder';
  } else if (platform === 'darwin' && available.has('h264_videotoolbox')) {
    chosen = 'h264_videotoolbox';
    reason = 'videotoolbox-hardware-fallback';
  } else {
    throw new H264EncoderUnavailableError(
      'No compatible H.264 encoder found in FFmpeg capabilities. Neither libx264 nor h264_videotoolbox is available.',
      ['Install FFmpeg with libx264 support (e.g. brew install ffmpeg)', 'VIDMYO_FFMPEG_PATH=/path/to/ffmpeg'],
    );
  }

  let args;
  if (chosen === 'libx264') {
    if (realtime) {
      const effectiveCrf = crf != null ? String(crf) : '23';
      args = [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', effectiveCrf,
        '-pix_fmt', 'yuv420p',
      ];
    } else {
      const effectiveCrf = crf != null ? String(crf) : (isPreview ? '28' : '18');
      args = [
        '-c:v', 'libx264',
        '-preset', isPreview ? 'ultrafast' : 'medium',
        '-crf', effectiveCrf,
        '-pix_fmt', 'yuv420p',
      ];
    }
  } else {
    // h264_videotoolbox
    const h = Number(height) || 720;
    const bitrate = (isPreview || h <= 720) ? '2M' : (h <= 1080 ? '6M' : '12M');
    args = [
      '-c:v', 'h264_videotoolbox',
      '-b:v', bitrate,
      ...(realtime ? ['-realtime', '1'] : ['-profile:v', 'high']),
      '-pix_fmt', 'yuv420p',
    ];
  }

  return {
    name: chosen,
    reason,
    args,
  };
}

/** Non-throwing variant for IPC/UI surfaces. */
export function tryProbeFfmpegCapabilities(options = {}) {
  try {
    return { ok: true, report: probeFfmpegCapabilities(options) };
  } catch (err) {
    return {
      ok: false,
      code: err.code || FFMPEG_PROBE_FAILED,
      error: err.message,
      ffmpegPath: err.ffmpegPath || options.ffmpegPath || null,
      hints: err.hints || [],
    };
  }
}

export function clearFfmpegCapabilityCache() {
  probeCache.clear();
}

