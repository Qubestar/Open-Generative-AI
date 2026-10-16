import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createEdgTimeline, validateEdg } from './edg.js';
import { resolveFfmpegBinary, RendererAdapter } from './rendererAdapter.js';
import { runGovernedFfmpeg } from './governedProcess.js';
import { selectH264Encoder, tryProbeFfmpegCapabilities } from './ffmpegCapabilities.js';
import { ResourceGovernor } from './governor.js';
import { vidmyoHome } from './paths.cjs';
import { secondsToFrame } from './timebase.js';
import { mapCursorToRecording, matchRecordingToDisplay, detectDwellEvents, microphoneTrackPath } from './screenCapture.js';

export const CANVAS_STYLE_PRESETS = {
  GRADIENT_PURPLE: 'radial-gradient(circle at 50% 50%, #7c3aed 0%, #1e1b4b 100%)',
  GRADIENT_SUNSET: 'linear-gradient(135deg, #f97316 0%, #ec4899 50%, #3b82f6 100%)',
  MINIMAL_DARK:    '#09090b',
};

// FFmpeg sources matching CANVAS_STYLE_PRESETS for real-recording exports.
// NONE keeps the recording full-frame (no background, no inset window).
const CANVAS_FFMPEG_SOURCES = {
  GRADIENT_PURPLE: (w, h) => `gradients=s=${w}x${h}:type=radial:c0=0x7c3aed:c1=0x1e1b4b:x0=${w / 2}:y0=${h / 2}:x1=0:y1=0:speed=0`,
  GRADIENT_SUNSET: (w, h) => `gradients=s=${w}x${h}:type=linear:nb_colors=3:c0=0xf97316:c1=0xec4899:c2=0x3b82f6:x0=0:y0=0:x1=${w}:y1=${h}:speed=0`,
  MINIMAL_DARK: (w, h) => `color=c=0x09090b:s=${w}x${h}`,
};

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Builds the filter_complex video chain for a real-recording export.
 * With a canvas preset the recording is inset (88% of the frame) as a
 * rounded-corner window over the background, like Screen Studio; with 'NONE'
 * it is scaled/letterboxed full-frame. Returns a graph that ends in [vout].
 */
export function buildRecordingCanvasGraph({
  preFilters = [],
  inputWidth,
  inputHeight,
  width,
  height,
  fps,
  frames,
  backgroundPreset = 'NONE',
  cornerRadius = DEFAULT_WINDOW_STYLING.cornerRadius,
} = {}) {
  const pre = [...preFilters, `fps=${fps}`];
  const bgSource = CANVAS_FFMPEG_SOURCES[backgroundPreset];
  if (!bgSource) {
    pre.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
    pre.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
    return `[0:v]${pre.join(',')}[vout]`;
  }

  const fit = Math.min((width * 0.88) / inputWidth, (height * 0.88) / inputHeight);
  const vw = even(inputWidth * fit);
  const vh = even(inputHeight * fit);
  const r = Math.max(2, Math.round(cornerRadius * (Math.min(width, height) / 1080)));
  // Rounded-rectangle alpha mask, computed once (single frame) then looped.
  const dx = `(abs(X-W/2+0.5)-(W/2-${r}))`;
  const dy = `(abs(Y-H/2+0.5)-(H/2-${r}))`;
  const maskExpr = `if(gt(${dx},0)*gt(${dy},0),if(lte(hypot(${dx},${dy}),${r}),255,0),255)`;
  const loops = Math.max(1, Math.ceil(frames));

  return [
    `[0:v]${pre.join(',')},scale=${vw}:${vh},format=yuva420p[win]`,
    `color=c=black:s=${vw}x${vh}:d=1,format=gray,geq=lum='${maskExpr}',trim=end_frame=1,loop=loop=${loops}:size=1:start=0,setpts=N/${fps}/TB[mask]`,
    `[win][mask]alphamerge[rounded]`,
    `${bgSource(width, height)}:r=${fps}:d=0.04,trim=end_frame=1,loop=loop=${loops}:size=1:start=0,setpts=N/${fps}/TB,format=yuv420p[bg]`,
    `[bg][rounded]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[vout]`,
  ].join(';');
}

const clampGain = (v) => Math.min(2, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 1));

/**
 * Audio part of a real-recording export: system audio ([0:a]) and the separate
 * microphone track mixed at the given gains. Returns null when there is no
 * audible source (caller adds a silent track), otherwise a graph ending in [aout].
 */
export function buildRecordingAudioGraph({
  hasSystemAudio = false,
  hasMic = false,
  micInputIndex = 1,
  micVolume = 1,
  systemVolume = 1,
} = {}) {
  const sys = hasSystemAudio && clampGain(systemVolume) > 0;
  const mic = hasMic && clampGain(micVolume) > 0;
  if (!sys && !mic) return null;
  const parts = [];
  if (sys) parts.push(`[0:a]volume=${clampGain(systemVolume)},aresample=48000:async=1,aformat=channel_layouts=stereo[sys]`);
  if (mic) parts.push(`[${micInputIndex}:a]volume=${clampGain(micVolume)},aresample=48000,aformat=channel_layouts=stereo[mic]`);
  if (sys && mic) parts.push('[sys][mic]amix=inputs=2:normalize=0:duration=longest,apad[aout]');
  else parts.push(`[${sys ? 'sys' : 'mic'}]apad[aout]`);
  return parts.join(';');
}

export const DEFAULT_WINDOW_STYLING = {
  cornerRadius: 16,
  shadowBlur: 40,
  shadowColor: 'rgba(0, 0, 0, 0.55)',
  borderWidth: 1,
  borderColor: 'rgba(255, 255, 255, 0.12)',
};

/**
 * Desktop Capture Adapter abstraction.
 * Reflects native macOS ScreenCaptureKit status and TCC requirements.
 */
export class DesktopCaptureAdapter {
  constructor({ tccGranted = false } = {}) {
    this.tccGranted = tccGranted;
  }

  checkScreenRecordingPermission() {
    return {
      granted: this.tccGranted,
      platform: process.platform,
      reason: this.tccGranted
        ? 'Screen Recording permitted'
        : 'macOS TCC Screen Recording permission not granted. Native ScreenCaptureKit capture requires user authorization in System Settings -> Privacy & Security -> Screen Recording.',
      fallbackAvailable: true,
      fallbackMode: 'synthetic_session_generator',
    };
  }
}

/**
 * Real macOS TCC screen-recording permission check.
 * `getMediaAccessStatus` is injected (Electron's systemPreferences.getMediaAccessStatus)
 * so this module has no hard Electron dependency and stays testable outside Electron.
 * Unlike DesktopCaptureAdapter (which just echoes back a boolean the caller supplies),
 * this reads the actual OS-reported status when one is available.
 */
export function checkNativeScreenRecordingPermission({
  platform = process.platform,
  getMediaAccessStatus = null,
} = {}) {
  if (platform !== 'darwin') {
    // avfoundation capture (below) is macOS-only. Windows/Linux native capture
    // (gdigrab/x11grab) is not implemented in this pass — tracked as a gap,
    // not silently claimed to work.
    return {
      granted: false,
      platform,
      reason: `Native capture adapter in this build targets macOS (avfoundation). Platform '${platform}' has no capture backend yet.`,
      fallbackAvailable: true,
      fallbackMode: 'synthetic_session_generator',
    };
  }
  if (typeof getMediaAccessStatus !== 'function') {
    return {
      granted: false,
      platform,
      reason: 'macOS TCC status unavailable outside the Electron main process. Wire systemPreferences.getMediaAccessStatus in to get a real reading.',
      fallbackAvailable: true,
      fallbackMode: 'synthetic_session_generator',
    };
  }
  const status = getMediaAccessStatus('screen'); // 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  const granted = status === 'granted';
  return {
    granted,
    platform,
    status,
    reason: granted
      ? 'Screen Recording permitted (macOS TCC).'
      : `macOS TCC Screen Recording permission is '${status}'. Native capture requires authorization in System Settings -> Privacy & Security -> Screen Recording.`,
    fallbackAvailable: true,
    fallbackMode: 'synthetic_session_generator',
  };
}

/**
 * Parses `ffmpeg -f avfoundation -list_devices true -i ""` stderr output into
 * structured video/audio device lists, flagging screen-capture entries
 * (ffmpeg labels them "Capture screen N") so callers can distinguish displays
 * from cameras/windows.
 */
export function parseAvfoundationDevices(stderrText) {
  const lines = String(stderrText || '').split('\n');
  const video = [];
  const audio = [];
  let section = null;
  for (const line of lines) {
    if (/AVFoundation video devices/i.test(line)) { section = 'video'; continue; }
    if (/AVFoundation audio devices/i.test(line)) { section = 'audio'; continue; }
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m && section) {
      const entry = { index: Number(m[1]), name: m[2].trim() };
      if (section === 'video') {
        entry.isScreen = /^Capture screen/i.test(entry.name);
        video.push(entry);
      } else {
        audio.push(entry);
      }
    }
  }
  return { video, audio, screens: video.filter(d => d.isScreen) };
}

/**
 * Enumerates real macOS avfoundation capture devices (displays, cameras,
 * microphones) via ffmpeg. This lists actual hardware/displays present on
 * the machine running it — it does not require Screen Recording TCC
 * authorization to list, only to actually capture pixels.
 */
export async function listAvfoundationCaptureDevices({ ffmpegBinary = null, spawnImpl = spawn } = {}) {
  const binary = resolveFfmpegBinary(ffmpegBinary);
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnImpl(binary, ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    // ffmpeg intentionally exits non-zero for -list_devices (no capture requested);
    // that is the expected way to enumerate, not a failure.
    proc.on('close', () => resolve(parseAvfoundationDevices(stderr)));
  });
}

/**
 * Monotonic-clock cursor telemetry sampler for real capture sessions.
 * `getCursorPoint` is injected (e.g. Electron's screen.getCursorScreenPoint)
 * so this reads the actual global cursor position, not synthetic motion.
 * Samples are timestamped relative to `start()` using the same monotonic
 * clock (`now`, defaulting to performance.now()) so they can be correlated
 * against the capture's own PTS, which also starts at 0 for the session.
 */
export function createCursorTelemetrySampler({
  intervalMs = 33,
  getCursorPoint,
  now = () => performance.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof getCursorPoint !== 'function') {
    throw new Error('getCursorPoint is required for real cursor telemetry (e.g. Electron screen.getCursorScreenPoint)');
  }
  const samples = [];
  let timer = null;
  let startedAtMs = null;
  return {
    start() {
      startedAtMs = now();
      samples.length = 0;
      timer = setIntervalImpl(() => {
        const p = getCursorPoint();
        samples.push({ tMonotonicMs: Math.round((now() - startedAtMs) * 1000) / 1000, x: p.x, y: p.y });
      }, intervalMs);
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
      return samples.slice();
    },
    samples() { return samples.slice(); },
  };
}

/**
 * Starts a real macOS screen capture via ffmpeg's avfoundation input,
 * optionally paired with a cursor telemetry sampler on the same monotonic
 * clock anchor. This is a genuine capture path (not the synthetic
 * generator above) — gated by checkNativeScreenRecordingPermission and
 * unverified beyond argument/parse-level testing without real macOS TCC
 * hardware access in this environment.
 *
 * `videoDeviceIndex` selects which avfoundation video device to capture —
 * for multi-display setups, each display enumerates as a separate
 * "Capture screen N" device (see listAvfoundationCaptureDevices().screens).
 * `audioDeviceIndex` selects a microphone device; pass null to capture
 * video only. System-audio capture requires a virtual loopback audio
 * device (e.g. BlackHole) to appear in the avfoundation audio device list —
 * ffmpeg/avfoundation has no OS-level "system audio" input of its own.
 *
 * @deprecated Use startGovernedCapture in screenCapture.js instead.
 */
export function startNativeScreenCapture({
  videoDeviceIndex,
  audioDeviceIndex = null,
  outputPath,
  fps = 30,
  ffmpegBinary = null,
  spawnImpl = spawn,
  cursorSampler = null,
} = {}) {
  if (videoDeviceIndex === undefined || videoDeviceIndex === null) {
    throw new Error('videoDeviceIndex is required (see listAvfoundationCaptureDevices().screens)');
  }
  if (!outputPath) throw new Error('outputPath is required for startNativeScreenCapture');
  const binary = resolveFfmpegBinary(ffmpegBinary);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const hasAudio = audioDeviceIndex !== null && audioDeviceIndex !== undefined;
  const inputSpec = hasAudio ? `${videoDeviceIndex}:${audioDeviceIndex}` : `${videoDeviceIndex}:none`;

  const args = [
    '-y',
    '-f', 'avfoundation',
    '-framerate', String(fps),
    '-capture_cursor', '1',
    '-i', inputSpec,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-ar', '48000'] : []),
    outputPath,
  ];

  const startedAtMs = Date.now();
  const proc = spawnImpl(binary, args);
  if (cursorSampler) cursorSampler.start();

  return {
    pid: proc.pid,
    startedAtMs,
    args,
    process: proc,
    async stop({ escalateAfterMs = 4000, killImpl = null } = {}) {
      const telemetry = cursorSampler ? cursorSampler.stop() : [];
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        proc.once('exit', done);
        proc.once('close', done);
        const kill = killImpl || ((signal) => proc.kill(signal));
        try { kill('SIGINT'); } catch { /* process may already be gone */ }
        const escalate = setTimeout(() => { try { kill('SIGKILL'); } catch { /* already exited */ } }, escalateAfterMs);
        proc.once('exit', () => clearTimeout(escalate));
      });
      return { outputPath, telemetry, startedAtMs };
    },
  };
}

/**
 * Enumerates native display sources and application windows via Electron's desktopCapturer and screen API.
 * Pairs display sources with physical display geometry and refresh rates.
 * Marked 'unverified-on-hardware' when running without real TCC permissions.
 */
export async function listNativeCaptureSources({
  desktopCapturer = null,
  screen = null,
} = {}) {
  let sources = [];
  if (desktopCapturer && typeof desktopCapturer.getSources === 'function') {
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: true,
        thumbnailSize: { width: 320, height: 180 },
      });
    } catch {
      sources = [];
    }
  }

  const displays = [];
  const windows = [];

  const electronDisplays = screen && typeof screen.getAllDisplays === 'function'
    ? screen.getAllDisplays()
    : [];

  for (const src of sources) {
    if (src.id.startsWith('screen:')) {
      const matchDisplay = electronDisplays.find(d => String(d.id) === src.display_id);
      displays.push({
        id: src.id,
        name: src.name || 'Display',
        displayId: src.display_id,
        thumbnail: src.thumbnail?.toDataURL ? src.thumbnail.toDataURL() : null,
        bounds: matchDisplay?.bounds || { width: 1920, height: 1080 },
        scaleFactor: matchDisplay?.scaleFactor || 1,
        isPrimary: matchDisplay ? matchDisplay.bounds.x === 0 && matchDisplay.bounds.y === 0 : true,
      });
    } else {
      windows.push({
        id: src.id,
        name: src.name,
        thumbnail: src.thumbnail?.toDataURL ? src.thumbnail.toDataURL() : null,
        appIcon: src.appIcon?.toDataURL ? src.appIcon.toDataURL() : null,
      });
    }
  }

  return {
    displays,
    windows,
    totalSources: displays.length + windows.length,
    hardwareVerificationStatus: 'unverified-on-hardware',
    platform: process.platform,
    requiresTcc: process.platform === 'darwin',
  };
}

/**
 * Native Screen Capture Session coordinator.
 * Coordinates multi-display selection, audio device selection (mic / system audio loopback),
 * monotonic cursor clock telemetry sampling, and avfoundation/desktopCapturer capture.
 * Kept strictly unverified-on-hardware when TCC permissions are absent in the host environment.
 */
export class NativeScreenCaptureSession {
  constructor({
    sourceId = 'screen:0:0',
    displayId = null,
    videoDeviceIndex = 0,
    audioDeviceIndex = null,
    outputPath,
    fps = 30,
    getCursorPoint = null,
    ffmpegBinary = null,
    now = () => performance.now(),
  } = {}) {
    if (!outputPath) throw new Error('outputPath is required for NativeScreenCaptureSession');
    this.sourceId = sourceId;
    this.displayId = displayId;
    this.videoDeviceIndex = videoDeviceIndex;
    this.audioDeviceIndex = audioDeviceIndex;
    this.outputPath = outputPath;
    this.fps = fps;
    this.getCursorPoint = getCursorPoint;
    this.ffmpegBinary = ffmpegBinary;
    this.now = now;
    this.activeCapture = null;
    this.cursorSampler = null;
    this.startedAtMs = null;
  }

  start() {
    this.startedAtMs = this.now();
    if (this.getCursorPoint) {
      this.cursorSampler = createCursorTelemetrySampler({
        intervalMs: Math.round(1000 / this.fps),
        getCursorPoint: this.getCursorPoint,
        now: this.now,
      });
    }

    this.activeCapture = startNativeScreenCapture({
      videoDeviceIndex: this.videoDeviceIndex,
      audioDeviceIndex: this.audioDeviceIndex,
      outputPath: this.outputPath,
      fps: this.fps,
      ffmpegBinary: this.ffmpegBinary,
      cursorSampler: this.cursorSampler,
    });

    return {
      status: 'recording',
      pid: this.activeCapture.pid,
      outputPath: this.outputPath,
      sourceId: this.sourceId,
      hardwareVerificationStatus: 'unverified-on-hardware',
      note: 'Native screen recording started behind TCC permission check. Hardware unverified without real display permissions in test environment.',
    };
  }

  async stop() {
    if (!this.activeCapture) throw new Error('No active capture session to stop');
    const stopResult = await this.activeCapture.stop();
    const durationSec = Math.max(0.1, (this.now() - this.startedAtMs) / 1000);

    const telemetry = (stopResult.telemetry || []).map((pt, idx) => ({
      frame: Math.round(pt.tMonotonicMs / (1000 / this.fps)),
      ptsSec: pt.tMonotonicMs / 1000,
      x: pt.x,
      y: pt.y,
      isClick: false,
    }));

    return {
      status: 'stopped',
      videoPath: this.outputPath,
      durationSec,
      fps: this.fps,
      screenWidth: 1920,
      screenHeight: 1080,
      telemetry,
      hardwareVerificationStatus: 'unverified-on-hardware',
    };
  }
}


/**
 * Synthetic Screen and Cursor Telemetry Generator.
 * Used for headless testing, CI, and environments without macOS ScreenCaptureKit TCC permissions.
 */
export function generateSyntheticScreenSession({
  durationSec = 5.0,
  fps = 30,
  screenWidth = 1920,
  screenHeight = 1080,
  interactions = [
    { timeSec: 1.5, x: 500, y: 300, type: 'click', targetName: 'Submit Button' },
    { timeSec: 3.2, x: 950, y: 650, type: 'click', targetName: 'Settings Tab' },
  ],
} = {}) {
  const totalFrames = Math.round(durationSec * fps);
  const telemetry = [];

  let currentX = screenWidth / 2;
  let currentY = screenHeight / 2;
  let nextInteractionIdx = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    const timeSec = frame / fps;
    let event = null;

    if (nextInteractionIdx < interactions.length) {
      const target = interactions[nextInteractionIdx];
      // Interpolate cursor towards target interaction point
      const timeDiff = target.timeSec - timeSec;
      if (timeDiff > 0 && timeDiff <= 1.0) {
        currentX += (target.x - currentX) * 0.25;
        currentY += (target.y - currentY) * 0.25;
      } else if (Math.abs(timeDiff) < (0.5 / fps)) {
        currentX = target.x;
        currentY = target.y;
        event = { type: target.type, targetName: target.targetName };
        nextInteractionIdx++;
      }
    }

    telemetry.push({
      frame,
      timeSec: parseFloat(timeSec.toFixed(3)),
      cursor: {
        x: Math.round(currentX),
        y: Math.round(currentY),
      },
      clickEvent: event,
    });
  }

  return {
    screenWidth,
    screenHeight,
    fps,
    durationSec,
    totalFrames,
    telemetry,
    interactions,
  };
}

/**
 * Computes Smart Auto-Zoom camera keyframes from cursor click/dwell telemetry.
 * Zooms smoothly toward click clusters and dwell events with spring/ease interpolation.
 */
export function computeAutoZoomKeyframes(telemetry = [], {
  screenWidth = 1920,
  screenHeight = 1080,
  zoomScale = 1.45,
  holdDurationSec = 1.5,
  dwellEvents = [],
} = {}) {
  const keyframes = [];
  let isZoomed = false;
  let zoomReleaseSec = 0;
  let currentTargetX = screenWidth / 2;
  let currentTargetY = screenHeight / 2;

  const dwellList = Array.isArray(dwellEvents) ? dwellEvents : [];

  for (const t of telemetry) {
    const timeSec = t.timeSec !== undefined ? t.timeSec : (t.tMonotonicMs ? t.tMonotonicMs / 1000 : 0);
    const cursorX = t.cursor?.x ?? t.x ?? screenWidth / 2;
    const cursorY = t.cursor?.y ?? t.y ?? screenHeight / 2;

    const isClick = t.clickEvent && (t.clickEvent.type === 'click' || t.clickEvent.type === 'dwell');
    const isDwellSample = t.dwellEvent || t.type === 'dwell';
    const activeDwell = dwellList.find((d) => {
      const dStart = d.tMs / 1000;
      const dEnd = (d.tMs + (d.durationMs || 1000)) / 1000;
      return Math.abs(dStart - timeSec) < 0.1 || (timeSec >= dStart && timeSec <= dEnd);
    });

    if (isClick || isDwellSample || activeDwell) {
      isZoomed = true;
      const targetX = activeDwell ? activeDwell.x : (t.dwellEvent?.x ?? cursorX);
      const targetY = activeDwell ? activeDwell.y : (t.dwellEvent?.y ?? cursorY);
      const duration = activeDwell ? Math.max(holdDurationSec, (activeDwell.durationMs || 1000) / 1000) : holdDurationSec;
      zoomReleaseSec = timeSec + duration;

      // Clamp target center point so zoom doesn't crop past outer borders
      const halfW = (screenWidth / zoomScale) / 2;
      const halfH = (screenHeight / zoomScale) / 2;
      currentTargetX = Math.max(halfW, Math.min(screenWidth - halfW, targetX));
      currentTargetY = Math.max(halfH, Math.min(screenHeight - halfH, targetY));
    }

    if (isZoomed && timeSec > zoomReleaseSec) {
      isZoomed = false;
      currentTargetX = screenWidth / 2;
      currentTargetY = screenHeight / 2;
    }

    keyframes.push({
      frame: t.frame !== undefined ? t.frame : Math.round(timeSec * 30),
      timeSec,
      scale: isZoomed ? zoomScale : 1.0,
      centerX: Math.round(currentTargetX),
      centerY: Math.round(currentTargetY),
    });
  }

  return keyframes;
}

/**
 * Extracts contiguous zoomed intervals from keyframes into discrete segments.
 */
export function extractZoomSegments(zoomKeyframes = [], fps = 30) {
  const segments = [];
  let inSegment = false;
  let segStart = 0;
  let segCenterX = 0;
  let segCenterY = 0;
  let segScale = 1.0;

  for (let i = 0; i < zoomKeyframes.length; i++) {
    const kf = zoomKeyframes[i];
    const zoomed = kf.scale > 1.05;
    if (zoomed && !inSegment) {
      inSegment = true;
      segStart = kf.timeSec !== undefined ? kf.timeSec : kf.frame / fps;
      segCenterX = kf.centerX;
      segCenterY = kf.centerY;
      segScale = kf.scale;
    } else if (!zoomed && inSegment) {
      inSegment = false;
      const segEnd = kf.timeSec !== undefined ? kf.timeSec : kf.frame / fps;
      if (segEnd > segStart) {
        segments.push({
          startSec: segStart,
          endSec: segEnd,
          centerX: segCenterX,
          centerY: segCenterY,
          scale: segScale,
        });
      }
    }
  }

  if (inSegment && zoomKeyframes.length > 0) {
    const last = zoomKeyframes[zoomKeyframes.length - 1];
    const segEnd = last.timeSec !== undefined ? last.timeSec : last.frame / fps;
    segments.push({
      startSec: segStart,
      endSec: Math.max(segStart + 0.5, segEnd),
      centerX: segCenterX,
      centerY: segCenterY,
      scale: segScale,
    });
  }

  return segments;
}

/**
 * Builds smoothstep easing crop filter (R5) with safety constraints:
 * - w and h forced even and >= 2
 * - x and y clamped to [0, in_w - w] and [0, in_h - h] with min()/max()
 * - max 64 segments and max 16 KB filter string
 */
export function buildAutoZoomCropFilter(zoomSegments = [], {
  inputWidth = 1920,
  inputHeight = 1080,
  zoomScale = 1.45,
} = {}) {
  if (!Array.isArray(zoomSegments) || zoomSegments.length === 0) {
    return { filter: null, zoomDisabledReason: 'no_zoom_segments' };
  }
  if (zoomSegments.length > 64) {
    return { filter: null, zoomDisabledReason: 'segment_limit_exceeded' };
  }

  // Crop w and h forced even and >= 2
  let wZoom = Math.floor(inputWidth / zoomScale);
  if (wZoom % 2 !== 0) wZoom -= 1;
  wZoom = Math.max(2, Math.min(inputWidth, wZoom));

  let hZoom = Math.floor(inputHeight / zoomScale);
  if (hZoom % 2 !== 0) hZoom -= 1;
  hZoom = Math.max(2, Math.min(inputHeight, hZoom));

  const transSec = 0.3;
  const primary = zoomSegments[0];
  const targetCx = Math.round(primary.centerX);
  const targetCy = Math.round(primary.centerY);

  const xZoom = Math.max(0, Math.min(inputWidth - wZoom, Math.round(targetCx - wZoom / 2)));
  const yZoom = Math.max(0, Math.min(inputHeight - hZoom, Math.round(targetCy - hZoom / 2)));

  const centerUnzoomedX = Math.round((inputWidth - wZoom) / 2);
  const centerUnzoomedY = Math.round((inputHeight - hZoom) / 2);

  const easeTerms = [];
  const enableRanges = [];

  for (const seg of zoomSegments) {
    const t0 = Math.max(0, Number(seg.startSec).toFixed(3));
    const t1 = Math.max(0, Number(seg.endSec).toFixed(3));
    enableRanges.push(`between(t,${t0},${t1})`);

    const pin = `clip((t-${t0})/${transSec},0,1)`;
    const pout = `clip((${t1}-t)/${transSec},0,1)`;
    const easeIn = `(3*pow(${pin},2)-2*pow(${pin},3))`;
    const easeOut = `(3*pow(${pout},2)-2*pow(${pout},3))`;
    easeTerms.push(`min(${easeIn},${easeOut})`);
  }

  const combinedEase = easeTerms.length === 1
    ? easeTerms[0]
    : easeTerms.reduce((acc, term) => `max(${acc},${term})`);

  const xExpr = `max(0,min(in_w-out_w,${centerUnzoomedX}+(${xZoom}-${centerUnzoomedX})*${combinedEase}))`;
  const yExpr = `max(0,min(in_h-out_h,${centerUnzoomedY}+(${yZoom}-${centerUnzoomedY})*${combinedEase}))`;
  const filter = `crop=w=${wZoom}:h=${hZoom}:x='${xExpr}':y='${yExpr}'`;

  if (Buffer.byteLength(filter, 'utf8') > 16384) {
    return { filter: null, zoomDisabledReason: 'filter_string_too_long' };
  }

  return { filter, zoomDisabledReason: null };
}

/**
 * Generates Studio Canvas layout configuration.
 */
export function createStudioCanvasConfig({
  backgroundPreset = 'GRADIENT_PURPLE',
  aspect = '16:9',
  windowStyling = DEFAULT_WINDOW_STYLING,
  webcamOverlay = null, // { enabled: boolean, x, y, radius, removeBackground: boolean }
} = {}) {
  return {
    aspect,
    background: CANVAS_STYLE_PRESETS[backgroundPreset] || CANVAS_STYLE_PRESETS.GRADIENT_PURPLE,
    window: {
      ...DEFAULT_WINDOW_STYLING,
      ...windowStyling,
    },
    webcamOverlay: webcamOverlay ? {
      enabled: webcamOverlay.enabled ?? true,
      x: webcamOverlay.x ?? 120,
      y: webcamOverlay.y ?? 120,
      radius: webcamOverlay.radius ?? 90,
      removeBackground: webcamOverlay.removeBackground ?? true,
    } : null,
  };
}

/**
 * Creates a valid EDG timeline from a Screen Studio recording session.
 */
export function createScreenStudioEdgTimeline(screenSession, zoomKeyframes = [], canvasConfig = null, {
  fps = 30,
  aspect = '16:9',
  title = 'Screen Studio Recording',
} = {}) {
  const totalFrames = screenSession.totalFrames || Math.round((screenSession.durationSec || 5) * fps);
  const edg = createEdgTimeline({
    title,
    aspect,
    fps,
    assets: {
      screen_source: {
        id: 'screen_source',
        path: 'screen_recording.mp4',
        hash: 'screen_cap_hash_v26',
        type: 'video',
        durationSec: screenSession.durationSec || 5,
      },
    },
    tracks: [
      {
        id: 'track_screen',
        type: 'video',
        name: 'Screen Recording',
        clips: [
          {
            id: 'clip_screen_0',
            assetId: 'screen_source',
            timelineStartFrame: 0,
            timelineEndFrame: totalFrames,
            sourceStartFrame: 0,
            sourceEndFrame: totalFrames,
          },
        ],
      },
      {
        id: 'track_overlay_canvas',
        type: 'overlay',
        name: 'Studio Canvas & Webcam',
        clips: [],
      },
      {
        id: 'track_audio_mic',
        type: 'audio',
        name: 'Microphone Narration',
        clips: [
          {
            id: 'clip_audio_0',
            assetId: 'screen_source',
            timelineStartFrame: 0,
            timelineEndFrame: totalFrames,
            sourceStartFrame: 0,
            sourceEndFrame: totalFrames,
          },
        ],
      },
    ],
  });

  edg.totalTimelineFrames = totalFrames;
  edg.meta = {
    studio: 'screen_studio',
    canvasConfig: canvasConfig || createStudioCanvasConfig(),
    zoomKeyframesCount: zoomKeyframes.length,
    interactionsCount: screenSession.interactions?.length || 0,
  };

  validateEdg(edg);
  return edg;
}

/**
 * Computes streamed SHA-256 hash of a media file.
 */
export async function computeStreamSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Creates an EDG timeline from a real Screen Studio recording file.
 * Streamed hash, probed duration, integer frames via timebase.js, and telemetry mapping.
 */
export async function createScreenStudioEdgFromRecording({
  recordingPath,
  telemetry = [],
  dwellEvents = [],
  aspect = '16:9',
  fps = 30,
  display = null,
  displays = [],
  title = 'Screen Studio Recording',
  ffmpegBinary = null,
  governor = null,
  jobId = null,
} = {}) {
  if (!recordingPath || !fs.existsSync(recordingPath)) {
    throw new Error(`Recording file does not exist: ${recordingPath}`);
  }

  const fileSha256 = await computeStreamSha256(recordingPath);
  const binary = resolveFfmpegBinary(ffmpegBinary);
  const adapter = new RendererAdapter({ ffmpegPath: binary });
  const probe = await adapter.probeMediaGoverned(recordingPath, { governor, jobId });

  const videoStream = probe.streams?.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');

  const durationSec = Number(videoStream?.duration || probe.format?.duration || 0);
  const width = Number(videoStream?.width || 1920);
  const height = Number(videoStream?.height || 1080);

  const totalFrames = secondsToFrame(durationSec, fps);

  // R9 Screen matching by resolution
  let matchedDisplay = display;
  let telemetryStatus = 'ok';
  if (!matchedDisplay && displays && displays.length > 0) {
    const match = matchRecordingToDisplay(displays, { recordingWidth: width, recordingHeight: height });
    matchedDisplay = match.matchedDisplay;
    telemetryStatus = match.telemetryStatus;
  } else if (!matchedDisplay) {
    telemetryStatus = 'display_mapping_uncertain';
  }

  let mappedTelemetry = [];
  if (telemetryStatus === 'ok' && matchedDisplay) {
    mappedTelemetry = telemetry.map((pt) => mapCursorToRecording(pt, matchedDisplay, { recordingWidth: width, recordingHeight: height })).filter(Boolean);
  } else {
    mappedTelemetry = telemetry.slice();
  }

  const detectedDwells = dwellEvents.length > 0 ? dwellEvents : detectDwellEvents(mappedTelemetry);
  const zoomKeyframes = telemetryStatus === 'ok'
    ? computeAutoZoomKeyframes(mappedTelemetry, { screenWidth: width, screenHeight: height, dwellEvents: detectedDwells })
    : [];

  const zoomSegments = extractZoomSegments(zoomKeyframes, fps);

  const edg = createEdgTimeline({
    title,
    aspect,
    fps,
    assets: {
      screen_source: {
        id: 'screen_source',
        path: recordingPath,
        hash: fileSha256,
        type: 'video',
        durationSec,
        width,
        height,
      },
    },
    tracks: [
      {
        id: 'track_screen',
        type: 'video',
        name: 'Screen Recording',
        clips: [
          {
            id: 'clip_screen_0',
            assetId: 'screen_source',
            timelineStartFrame: 0,
            timelineEndFrame: totalFrames,
            sourceStartFrame: 0,
            sourceEndFrame: totalFrames,
          },
        ],
      },
      ...(audioStream ? [{
        id: 'track_audio_screen',
        type: 'audio',
        name: 'Recording Audio',
        clips: [
          {
            id: 'clip_audio_0',
            assetId: 'screen_source',
            timelineStartFrame: 0,
            timelineEndFrame: totalFrames,
            sourceStartFrame: 0,
            sourceEndFrame: totalFrames,
          },
        ],
      }] : []),
    ],
  });

  edg.totalTimelineFrames = totalFrames;
  edg.meta = {
    studio: 'screen_studio',
    source: 'recording',
    clickSource: detectedDwells.length > 0 ? 'dwell_heuristic' : 'cursor_telemetry',
    telemetryStatus,
    zoomKeyframes,
    zoomSegments,
    durationSec,
    width,
    height,
  };

  validateEdg(edg);

  return {
    edg,
    hash: fileSha256,
    durationSec,
    totalFrames,
    zoomKeyframes,
    zoomSegments,
    telemetryStatus,
  };
}

/**
 * Renders a Screen Studio video export with styled padding and canvas background.
 */
export async function renderScreenStudioExport(edg, outputPath, {
  fps = 30,
  width = 1280,
  height = 720,
  ffmpegBinary = null,
  governor = null,
  jobId = null,
  signal = null,
  timeoutMs = null,
  encoderOverride = null,
  capabilities = null,
  // Real-recording exports only: canvas background ('NONE' = full frame)
  // and whether Smart Auto-Zoom crops are applied.
  backgroundPreset = 'NONE',
  autoZoom = true,
  // Audio mixer gains (1 = unchanged, 0 = muted, up to 2). The microphone is a
  // separate <recording>.mic.m4a track when the recording has one.
  micVolume = 1,
  systemVolume = 1,
} = {}) {
  const binary = resolveFfmpegBinary(ffmpegBinary);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const durationSec = (edg.totalTimelineFrames || 60) / fps;
  const effectiveGovernor = governor || new ResourceGovernor({ home: vidmyoHome() });
  const effectiveJobId = jobId || `job_screen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Branch 1: Export from a real screen recording (R4, R5)
  if (edg.meta?.source === 'recording') {
    const inputPath = edg.assets?.screen_source?.path;
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error(`Screen recording source file not found: ${inputPath}`);
    }

    const adapter = new RendererAdapter({ ffmpegPath: binary });
    const probe = await adapter.probeMediaGoverned(inputPath, {
      governor: effectiveGovernor,
      jobId: effectiveJobId,
      signal,
    });
    const videoStream = probe.streams?.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams?.find((s) => s.codec_type === 'audio');
    const inputWidth = Number(videoStream?.width || width);
    const inputHeight = Number(videoStream?.height || height);
    const probeDuration = Number(videoStream?.duration || probe.format?.duration || durationSec);

    // Zoom segments from keyframes or meta
    const zoomSegments = edg.meta?.zoomSegments || extractZoomSegments(edg.meta?.zoomKeyframes || [], fps);
    const { filter: cropFilter, zoomDisabledReason } = edg.meta?.telemetryStatus === 'display_mapping_uncertain'
      ? { filter: null, zoomDisabledReason: 'display_mapping_uncertain' }
      : buildAutoZoomCropFilter(zoomSegments, { inputWidth, inputHeight, zoomScale: 1.45 });

    const useZoom = autoZoom && Boolean(cropFilter);
    const filterComplex = buildRecordingCanvasGraph({
      preFilters: useZoom ? [cropFilter] : [],
      inputWidth,
      inputHeight,
      width,
      height,
      fps,
      frames: probeDuration * fps,
      backgroundPreset,
    });

    const caps = capabilities || (ffmpegBinary ? { encoders: { libx264: true } } : tryProbeFfmpegCapabilities({ ffmpegPath: binary }).report);
    const encoderSelection = selectH264Encoder(caps, {
      isPreview: false,
      height,
      override: encoderOverride,
    });

    const micPath = microphoneTrackPath(inputPath);
    const hasMic = fs.existsSync(micPath);
    const audioGraph = buildRecordingAudioGraph({
      hasSystemAudio: Boolean(audioStream),
      hasMic,
      micInputIndex: 1,
      micVolume,
      systemVolume,
    });

    const args = ['-y', '-i', inputPath];
    if (hasMic) args.push('-i', micPath);
    if (audioGraph) {
      args.push(
        '-filter_complex', `${filterComplex};${audioGraph}`,
        '-map', '[vout]',
        '-map', '[aout]',
        ...encoderSelection.args,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-t', String(probeDuration),
        outputPath,
      );
    } else {
      args.push(
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', `${hasMic ? 2 : 1}:a`,
        ...encoderSelection.args,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-t', String(probeDuration),
        outputPath,
      );
    }

    let run;
    try {
      run = await runGovernedFfmpeg({
        cmd: binary,
        args,
        governor: effectiveGovernor,
        jobId: effectiveJobId,
        signal,
        timeoutMs: timeoutMs || Math.max(120000, Math.round(probeDuration * 1000 * 10)),
        resourceClass: 'heavy',
        waitForSlotMs: 5000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      if (outputPath) {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
      }
      throw err;
    }

    if (run.exitCode === 0 && fs.existsSync(outputPath)) {
      return {
        ok: true,
        outputPath,
        durationSec: probeDuration,
        dimensions: { width, height },
        encoder: { name: encoderSelection.name, reason: encoderSelection.reason },
        zoomApplied: useZoom,
        zoomDisabledReason: autoZoom ? zoomDisabledReason : 'disabled_by_user',
        backgroundPreset,
      };
    }

    if (outputPath) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    const stderrTail = run.stderr ? String(run.stderr).slice(-500) : '';
    throw new Error(`FFmpeg Screen Studio recording render failed with code ${run.exitCode}: ${stderrTail}`);
  }

  // Branch 2: Demo (synthetic) flow — byte-for-byte identical to Phase 4
  const filterGraph = [
    `color=c=#1e1b4b:s=${width}x${height}:r=${fps}:d=${durationSec}`,
    `drawbox=x=80:y=60:w=${width - 160}:h=${height - 120}:color=#0f172a@1:t=fill`,
    `drawbox=x=100:y=80:w=12:h=12:color=#ef4444@1:t=fill`,
    `drawbox=x=120:y=80:w=12:h=12:color=#eab308@1:t=fill`,
    `drawbox=x=140:y=80:w=12:h=12:color=#22c55e@1:t=fill`,
  ].join(',');

  const caps = capabilities || (ffmpegBinary ? { encoders: { libx264: true } } : tryProbeFfmpegCapabilities({ ffmpegPath: binary }).report);
  const encoderSelection = selectH264Encoder(caps, {
    isPreview: false,
    height,
    override: encoderOverride,
  });

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', filterGraph,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(durationSec),
    ...encoderSelection.args,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    outputPath,
  ];

  let run;
  try {
    run = await runGovernedFfmpeg({
      cmd: binary,
      args,
      governor: effectiveGovernor,
      jobId: effectiveJobId,
      signal,
      timeoutMs: timeoutMs || Math.max(120000, Math.round(durationSec * 1000 * 10)),
      resourceClass: 'heavy',
      waitForSlotMs: 5000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    if (outputPath) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    throw err;
  }

  if (run.exitCode === 0 && fs.existsSync(outputPath)) {
    return {
      ok: true,
      outputPath,
      durationSec,
      dimensions: { width, height },
      encoder: { name: encoderSelection.name, reason: encoderSelection.reason },
    };
  }

  if (outputPath) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
  }
  const stderrTail = run.stderr ? String(run.stderr).slice(-500) : '';
  throw new Error(`FFmpeg Screen Studio render failed with code ${run.exitCode}: ${stderrTail}`);
}

