// Real macOS Screen Studio capture runner with Resource Governor admission,
// fragmented MP4 recording, monotonic cursor telemetry, and smart auto-zoom mapping.
// Phase 5, Step 2 (Checkpoint B).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFfmpegBinary, resolveFfprobeBinary } from './rendererAdapter.js';
import { selectH264Encoder, tryProbeFfmpegCapabilities } from './ffmpegCapabilities.js';
import { runGovernedFfmpeg } from './governedProcess.js';

export const VALID_RECORDING_FPS = new Set([24, 25, 30, 60]);
export const MAX_RECORDING_DURATION_SEC = 7200;
export const MIN_RECORDING_DURATION_SEC = 1;
export const MAX_CURSOR_SAMPLES = MAX_RECORDING_DURATION_SEC * 30; // 216,000 entries

/**
 * Validates a screen capture request before governor admission or spawning.
 */
export function validateCaptureRequest({
  videoDeviceIndex,
  audioDeviceIndex = null,
  systemAudioDeviceIndex = null,
  fps = 30,
  maxDurationSec = 7200,
  outputPath,
} = {}) {
  if (videoDeviceIndex === undefined || videoDeviceIndex === null || videoDeviceIndex === '') {
    throw new Error('videoDeviceIndex is required (e.g. 0, 1 for displays)');
  }
  const videoIdx = Number(videoDeviceIndex);
  if (!Number.isInteger(videoIdx) || videoIdx < 0) {
    throw new Error(`Invalid videoDeviceIndex: ${videoDeviceIndex}. Must be a non-negative integer.`);
  }

  if (!VALID_RECORDING_FPS.has(Number(fps))) {
    throw new Error(`Invalid fps: ${fps}. Must be one of: 24, 25, 30, 60.`);
  }

  const duration = Number(maxDurationSec);
  if (!Number.isFinite(duration) || duration < MIN_RECORDING_DURATION_SEC || duration > MAX_RECORDING_DURATION_SEC) {
    throw new Error(`Invalid maxDurationSec: ${maxDurationSec}. Must be between 1 and 7200 seconds.`);
  }

  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('outputPath must be a valid non-empty string');
  }
  if (outputPath.includes('..')) {
    throw new Error('outputPath cannot contain relative path traversal (..)');
  }
  if (!outputPath.toLowerCase().endsWith('.mp4')) {
    throw new Error('outputPath must end with .mp4');
  }

  if (audioDeviceIndex !== null && audioDeviceIndex !== undefined && audioDeviceIndex !== 'none') {
    const aIdx = Number(audioDeviceIndex);
    if (!Number.isInteger(aIdx) || aIdx < 0) {
      throw new Error(`Invalid audioDeviceIndex: ${audioDeviceIndex}`);
    }
  }

  if (systemAudioDeviceIndex !== null && systemAudioDeviceIndex !== undefined && systemAudioDeviceIndex !== 'none') {
    const sIdx = Number(systemAudioDeviceIndex);
    if (!Number.isInteger(sIdx) || sIdx < 0) {
      throw new Error(`Invalid systemAudioDeviceIndex: ${systemAudioDeviceIndex}`);
    }
  }

  return true;
}

/**
 * Arguments for the native ScreenCaptureKit helper (native/screen-capture).
 * ffmpeg's avfoundation screen input yields no frames on macOS 15+, and the
 * helper also records system audio without a loopback driver such as BlackHole.
 */
export function buildHelperCaptureArgs({
  displayId,
  microphoneId = null,
  systemAudio = false,
  fps = 30,
  outputPath,
} = {}) {
  const id = Number(displayId);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid displayId: ${displayId}`);
  }
  if (microphoneId !== null && microphoneId !== undefined && (typeof microphoneId !== 'string' || !microphoneId)) {
    throw new Error(`Invalid microphoneId: ${microphoneId}`);
  }
  const args = ['record', '--display', String(id), '--out', outputPath, '--fps', String(fps)];
  if (systemAudio) args.push('--system-audio');
  if (microphoneId) args.push('--mic', microphoneId);
  return args;
}

function runToCompletion(binary, args, { spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-8192); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Lists displays and microphones through the native helper.
 * Returns { displays: [{id,name,width,height,isMain}], microphones: [{id,name,isDefault}] }.
 */
export async function listScreenCaptureKitSources({ helperBinary, spawnImpl = spawn } = {}) {
  const { code, stdout } = await runToCompletion(helperBinary, ['list'], { spawnImpl, timeoutMs: 15000 });
  const line = stdout.trim().split('\n').pop() || '{}';
  const parsed = JSON.parse(line);
  if (code !== 0) {
    const err = new Error(parsed.message || `capture helper exited with code ${code}`);
    err.code = code === 3 ? 'EPERM_SCREEN' : 'EHELPER';
    throw err;
  }
  return {
    displays: Array.isArray(parsed.displays) ? parsed.displays : [],
    microphones: Array.isArray(parsed.microphones) ? parsed.microphones : [],
  };
}

/**
 * Turns the helper's raw microphone sidecar into the recording's microphone
 * track: all channels summed to mono (multi-input interfaces put the voice on
 * one channel and leave the rest silent), aligned to the first video frame by
 * micOffsetMs, 48 kHz AAC. It stays a separate file (<recording>.mic.m4a) so
 * the mic / system-audio balance can be set later in the export mixer.
 */
export async function prepareMicrophoneTrack({
  micPath,
  micOffsetMs = 0,
  ffmpegBinary = null,
  spawnImpl = spawn,
  governor = null,
  jobId = null,
} = {}) {
  const ffprobe = resolveFfprobeBinary();
  const r = await runToCompletion(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels',
    '-of', 'csv=p=0', micPath,
  ], { spawnImpl });
  const micChannels = Number(r.stdout.trim().split('\n')[0]) || 1;

  const sum = Array.from({ length: micChannels }, (_, i) => `c${i}`).join('+');
  const offsetSec = Math.abs(Number(micOffsetMs) || 0) / 1000;
  const align = micOffsetMs > 0
    ? `,adelay=${Math.round(micOffsetMs)}:all=1`
    : (offsetSec > 0 ? `,atrim=start=${offsetSec.toFixed(3)},asetpts=PTS-STARTPTS` : '');

  const tmpPath = micPath.replace(/\.m4a$/i, '.aligned.m4a');
  const args = [
    '-y', '-i', micPath,
    '-af', `pan=mono|c0=${sum}${align},aresample=48000`,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    tmpPath,
  ];
  try {
    await runGovernedFfmpeg({
      cmd: resolveFfmpegBinary(ffmpegBinary),
      args,
      governor,
      jobId,
      timeoutMs: 30 * 60 * 1000,
      ...(spawnImpl !== spawn ? { spawnImpl } : {}),
    });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`microphone track failed: ${err.message}${err.stderr ? ` ${String(err.stderr).slice(-400)}` : ''}`);
  }
  if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error('microphone track produced no output');
  }
  fs.renameSync(tmpPath, micPath);
  return { ok: true, micPath, micChannels };
}

/** Path of a recording's separate microphone track (may not exist). */
export function microphoneTrackPath(recordingPath) {
  return recordingPath.replace(/\.mp4$/i, '.mic.m4a');
}

/**
 * Builds FFmpeg command line arguments for real screen capture on macOS avfoundation.
 *
 * Implements:
 * - Fragmented MP4 (+frag_keyframe+empty_moov+default_base_moof) for crash resilience
 * - Realtime H.264 encoding via selectH264Encoder(caps, { realtime: true })
 * - R3 audio mixing: amix=inputs=2:normalize=0:dropout_transition=0 then aresample=48000
 * - Optional -t limit
 */
export function buildCaptureArgs({
  videoDeviceIndex,
  audioDeviceIndex = null,
  systemAudioDeviceIndex = null,
  fps = 30,
  maxDurationSec = null,
  outputPath,
  caps = null,
  encoderOverride = null,
} = {}) {
  validateCaptureRequest({
    videoDeviceIndex,
    audioDeviceIndex,
    systemAudioDeviceIndex,
    fps,
    maxDurationSec: maxDurationSec || 7200,
    outputPath,
  });

  const hasMic = audioDeviceIndex !== null && audioDeviceIndex !== undefined && audioDeviceIndex !== 'none';
  const hasSys = systemAudioDeviceIndex !== null && systemAudioDeviceIndex !== undefined && systemAudioDeviceIndex !== 'none';

  const args = ['-y'];

  if (hasMic && hasSys) {
    // Two audio inputs: input 0 has video + mic; input 1 has system audio
    args.push(
      '-f', 'avfoundation',
      '-framerate', String(fps),
      '-capture_cursor', '1',
      '-i', `${videoDeviceIndex}:${audioDeviceIndex}`,
      '-f', 'avfoundation',
      '-i', `:${systemAudioDeviceIndex}`,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0:dropout_transition=0,aresample=48000[aout]',
      '-map', '0:v',
      '-map', '[aout]',
      '-c:a', 'aac',
      '-ar', '48000',
      '-b:a', '192k',
    );
  } else if (hasMic || hasSys) {
    const aIdx = hasMic ? audioDeviceIndex : systemAudioDeviceIndex;
    args.push(
      '-f', 'avfoundation',
      '-framerate', String(fps),
      '-capture_cursor', '1',
      '-i', `${videoDeviceIndex}:${aIdx}`,
      '-c:a', 'aac',
      '-ar', '48000',
      '-b:a', '192k',
    );
  } else {
    args.push(
      '-f', 'avfoundation',
      '-framerate', String(fps),
      '-capture_cursor', '1',
      '-i', `${videoDeviceIndex}:none`,
      '-an',
    );
  }

  // Requested input rate plus an explicit OUTPUT rate so the produced file is
  // always the requested rational fps. NOTE (real-hardware finding, 2026-09-26):
  // this Mac's display exposes only a single native mode (1920x1080@60); FFmpeg
  // rejects `-framerate 30` with "Selected framerate ... is not supported by the
  // device", and even at the supported 60 the avfoundation screen device opens
  // but yields zero frames. Real capture on this host is therefore
  // `blocked-unverified-hardware` (see STATUS/EVIDENCE); selecting a
  // device-supported input framerate automatically is tracked as remaining.
  args.push('-r', String(fps));

  // Realtime video encoder
  const encoder = selectH264Encoder(caps, {
    realtime: true,
    height: 1080,
    override: encoderOverride,
  });
  args.push(...encoder.args);

  // Fragmented MP4 flags for resilience against ungraceful termination
  args.push(
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
  );

  if (maxDurationSec && Number(maxDurationSec) > 0) {
    args.push('-t', String(maxDurationSec));
  }

  args.push(outputPath);
  return { args, encoder };
}

/**
 * Bounded memory 30 Hz cursor telemetry sampler (R6).
 *
 * Drops samples if moved < 2 px, but forces a sample at least every 500 ms.
 * Pre-allocates typed arrays up to 7200 s * 30 = 216,000 entries.
 */
export class CursorSampler {
  constructor({
    getCursorPoint,
    intervalMs = 33.333,
    maxDurationSec = MAX_RECORDING_DURATION_SEC,
    now = () => performance.now(),
    wallClockNow = () => Date.now(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (typeof getCursorPoint !== 'function') {
      throw new Error('getCursorPoint function is required for CursorSampler');
    }
    this.getCursorPoint = getCursorPoint;
    this.intervalMs = intervalMs;
    this.now = now;
    this.wallClockNow = wallClockNow;
    this.startedAtWallClockMs = null;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;

    const maxEntries = Math.min(MAX_CURSOR_SAMPLES, Math.ceil(maxDurationSec * 35));
    this.tMs = new Float64Array(maxEntries);
    this.x = new Float32Array(maxEntries);
    this.y = new Float32Array(maxEntries);
    this.count = 0;
    this.timer = null;
    this.startedAtMs = null;
    this.lastKeptMs = -Infinity;
    this.lastX = NaN;
    this.lastY = NaN;
    this.maxEntries = maxEntries;
  }

  start() {
    this.startedAtMs = this.now();
    this.startedAtWallClockMs = this.wallClockNow();
    this.count = 0;
    this.lastKeptMs = -Infinity;
    this.lastX = NaN;
    this.lastY = NaN;

    this.timer = this.setIntervalImpl(() => {
      this.sample();
    }, this.intervalMs);
  }

  sample() {
    if (this.count >= this.maxEntries) return;
    const pt = this.getCursorPoint();
    if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return;

    const nowMs = Math.max(0, this.now() - this.startedAtMs);
    const dt = nowMs - this.lastKeptMs;
    const dx = pt.x - this.lastX;
    const dy = pt.y - this.lastY;
    const dist = Number.isNaN(dx) ? Infinity : Math.hypot(dx, dy);

    // Keep if first sample, or moved >= 2 px, or >= 500 ms elapsed since last sample
    if (this.count === 0 || dist >= 2.0 || dt >= 500.0) {
      this.tMs[this.count] = Math.round(nowMs * 100) / 100;
      this.x[this.count] = pt.x;
      this.y[this.count] = pt.y;
      this.lastKeptMs = nowMs;
      this.lastX = pt.x;
      this.lastY = pt.y;
      this.count++;
    }
  }

  stop() {
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    return this.toArray();
  }

  toArray() {
    const result = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = {
        tMonotonicMs: this.tMs[i],
        x: this.x[i],
        y: this.y[i],
      };
    }
    return result;
  }
}

/**
 * Shifts cursor telemetry samples from the sampler's own monotonic clock onto
 * the capture clock. `CursorSampler` starts measuring before FFmpeg is spawned,
 * so every sample is offset by `captureT0Ms - samplerStartedAtMs`.
 *
 * Samples that fall before the capture began (negative recording time) are
 * dropped. If either timestamp is missing, the telemetry is returned unchanged
 * (never silently reinterpreted).
 */
export function shiftTelemetryToCaptureClock(telemetry = [], { captureT0Ms = null, samplerStartedAtMs = null } = {}) {
  if (!Array.isArray(telemetry) || telemetry.length === 0) return [];
  if (!Number.isFinite(captureT0Ms) || !Number.isFinite(samplerStartedAtMs)) {
    return telemetry.slice();
  }
  const offsetMs = captureT0Ms - samplerStartedAtMs;
  const shifted = [];
  for (const sample of telemetry) {
    if (!sample || !Number.isFinite(sample.tMonotonicMs)) continue;
    const t = sample.tMonotonicMs - offsetMs;
    if (t < 0) continue;
    shifted.push({ ...sample, tMonotonicMs: Math.round(t * 100) / 100 });
  }
  return shifted;
}

/**
 * Screen matching by resolution (R9).
 * Matches avfoundation probed screen resolution (W x H) against Electron displays
 * where display.bounds * scaleFactor == W x H.
 */
export function matchRecordingToDisplay(displays = [], { recordingWidth, recordingHeight } = {}) {
  if (!Array.isArray(displays) || displays.length === 0 || !recordingWidth || !recordingHeight) {
    return { matchedDisplay: null, telemetryStatus: 'display_mapping_uncertain' };
  }

  const matches = displays.filter((disp) => {
    const scale = Number(disp.scaleFactor) || 1;
    const w = Math.round((disp.bounds?.width || 0) * scale);
    const h = Math.round((disp.bounds?.height || 0) * scale);
    return w === Number(recordingWidth) && h === Number(recordingHeight);
  });

  if (matches.length === 1) {
    return { matchedDisplay: matches[0], telemetryStatus: 'ok' };
  }

  // 0 or multiple matches -> uncertain mapping (auto-zoom must be disabled)
  return { matchedDisplay: null, telemetryStatus: 'display_mapping_uncertain' };
}

/**
 * Maps global cursor points (DIPs) to recording pixel coordinates.
 */
export function mapCursorToRecording(point, display, { recordingWidth, recordingHeight } = {}) {
  if (!point || !display?.bounds || !recordingWidth || !recordingHeight) {
    return null;
  }

  const bounds = display.bounds;
  const relX = Math.max(0, Math.min(bounds.width, point.x - bounds.x));
  const relY = Math.max(0, Math.min(bounds.height, point.y - bounds.y));

  const scaleX = recordingWidth / bounds.width;
  const scaleY = recordingHeight / bounds.height;

  return {
    tMonotonicMs: point.tMonotonicMs,
    x: Math.round(relX * scaleX * 10) / 10,
    y: Math.round(relY * scaleY * 10) / 10,
  };
}

/**
 * Dwell detection for cursor telemetry.
 * Detects intervals where cursor stays within radiusPx for at least dwellDurationMs.
 * Labelled explicitly as "heuristic, not clicks".
 */
export function detectDwellEvents(samples = [], {
  dwellDurationMs = 600,
  radiusPx = 80,
} = {}) {
  const events = [];
  if (!Array.isArray(samples) || samples.length < 2) return events;

  let windowStartIdx = 0;

  for (let i = 1; i < samples.length; i++) {
    const startSample = samples[windowStartIdx];
    const curSample = samples[i];
    const duration = curSample.tMonotonicMs - startSample.tMonotonicMs;
    const dist = Math.hypot(curSample.x - startSample.x, curSample.y - startSample.y);

    if (dist > radiusPx) {
      if (duration >= dwellDurationMs) {
        events.push({
          tMs: startSample.tMonotonicMs,
          durationMs: Math.round(duration),
          x: startSample.x,
          y: startSample.y,
          type: 'dwell',
          label: 'heuristic, not clicks',
        });
      }
      windowStartIdx = i;
    } else if (i === samples.length - 1 && duration >= dwellDurationMs) {
      events.push({
        tMs: startSample.tMonotonicMs,
        durationMs: Math.round(duration),
        x: startSample.x,
        y: startSample.y,
        type: 'dwell',
        label: 'heuristic, not clicks',
      });
    }
  }

  return events;
}

/**
 * Starts a real governed screen capture session (Phase 5, Checkpoint B).
 *
 * Guarantees:
 * - ResourceGovernor admission under 'heavy' resource class (exclusivity)
 * - Refuses admission if heavy slot taken; never double-spawns
 * - Process runs in detached process group
 * - Timed out after (maxDurationSec * 1000) + 60,000 ms
 * - captureT0Ms extracted from stderr line "Input #0, avfoundation"
 * - stop() sends SIGINT to -pid, waits up to 10s, then escalates
 * - cancel() kills process tree and deletes output file
 */
export async function startGovernedCapture({
  videoDeviceIndex,
  audioDeviceIndex = null,
  systemAudioDeviceIndex = null,
  fps = 30,
  maxDurationSec = 7200,
  outputPath,
  governor,
  jobId,
  signal = null,
  ffmpegBinary = null,
  spawnImpl = spawn,
  caps = null,
  getCursorPoint = null,
  onSpawn = null,
  cancelEscalationMs = 3000,
  // Optional override for the watchdog timeout (used by tests to prove the
  // timeout path without waiting for maxDurationSec). Defaults to duration + 60s.
  timeoutMs = null,
  // Injectable signal seams. The real defaults send OS signals to the child
  // process group; tests that use fake PIDs MUST inject no-op stubs so a host
  // process that happens to own that PID is never signalled (review blocker 1).
  killImpl = (targetPid, signal) => process.kill(targetPid, signal),
  livenessImpl = undefined,
  // Native ScreenCaptureKit helper (macOS 15+). When set, displayId /
  // microphoneId / systemAudio are used instead of the avfoundation indexes.
  helperBinary = null,
  displayId = null,
  microphoneId = null,
  systemAudio = false,
} = {}) {
  if (!governor) {
    throw new Error('startGovernedCapture requires a ResourceGovernor instance');
  }
  if (!jobId) {
    throw new Error('startGovernedCapture requires a jobId');
  }
  if (signal?.aborted) {
    const err = new Error('Capture aborted before start');
    err.code = 'ECANCELLED';
    throw err;
  }

  const useHelper = Boolean(helperBinary);
  validateCaptureRequest({
    videoDeviceIndex: useHelper ? 0 : videoDeviceIndex,
    audioDeviceIndex: useHelper ? null : audioDeviceIndex,
    systemAudioDeviceIndex: useHelper ? null : systemAudioDeviceIndex,
    fps,
    maxDurationSec,
    outputPath,
  });
  const helperArgs = useHelper
    ? buildHelperCaptureArgs({ displayId, microphoneId, systemAudio, fps, outputPath })
    : null;

  // Resource governor admission (heavy slot, fail immediately if busy)
  const lease = governor.acquire({
    jobId,
    resourceClass: 'heavy',
    waitForSlotMs: 0,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  let binary;
  let args;
  let encoder;
  if (useHelper) {
    binary = helperBinary;
    args = helperArgs;
    encoder = { name: 'screencapturekit-h264', args: [] };
  } else {
    binary = resolveFfmpegBinary(ffmpegBinary);
    const effectiveCaps = caps || tryProbeFfmpegCapabilities({ ffmpegPath: binary }).report;
    ({ args, encoder } = buildCaptureArgs({
      videoDeviceIndex,
      audioDeviceIndex,
      systemAudioDeviceIndex,
      fps,
      maxDurationSec,
      outputPath,
      caps: effectiveCaps,
    }));
  }
  const micSidecarPath = microphoneTrackPath(outputPath);

  let cursorSampler = null;
  if (typeof getCursorPoint === 'function') {
    cursorSampler = new CursorSampler({ getCursorPoint, maxDurationSec });
    cursorSampler.start();
  }

  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (maxDurationSec * 1000) + 60000;
  let child;
  let released = false;

  const releaseLease = () => {
    if (!released) {
      released = true;
      try { governor.release(lease.token); } catch { /* ignore */ }
    }
  };

  try {
    child = spawnImpl(binary, args, {
      detached: true,
      stdio: ['ignore', useHelper ? 'pipe' : 'ignore', 'pipe'],
    });
  } catch (err) {
    releaseLease();
    if (cursorSampler) cursorSampler.stop();
    throw err;
  }

  const pid = child.pid;
  const startedAtMs = Date.now();
  let captureT0Ms = null;
  let stderrBuffer = '';

  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderrBuffer += str;
      if (stderrBuffer.length > 32768) {
        stderrBuffer = stderrBuffer.slice(-16384);
      }
      if (!captureT0Ms && str.includes('Input #0, avfoundation')) {
        captureT0Ms = Date.now();
      }
    });
  }

  // The helper reports JSON lines: started / stopped / error.
  let helperStopped = null;
  let lastError = null;
  if (useHelper && child.stdout && typeof child.stdout.on === 'function') {
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event === 'started' && !captureT0Ms) captureT0Ms = Date.now();
        else if (evt.event === 'stopped') helperStopped = evt;
        else if (evt.event === 'error') lastError = evt.message || 'capture helper error';
      }
    });
  }

  if (typeof onSpawn === 'function') {
    try { onSpawn(child); } catch { /* ignore */ }
  }

  let timeoutTimer = null;
  if (effectiveTimeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      try {
        governor.cancelProcessTree(pid, { killAfterMs: cancelEscalationMs, killImpl, livenessImpl });
      } catch { /* ignore */ }
    }, effectiveTimeoutMs);
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }
  }

  let isStopping = false;
  let isCancelled = false;
  let exitPromiseResolve;
  const exitPromise = new Promise((resolve) => {
    exitPromiseResolve = resolve;
  });

  child.once('exit', (code, sig) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Always stop the telemetry sampler when the process ends, even on a
    // self-exit (duration limit / crash), so it never keeps the loop alive.
    if (cursorSampler && !isCancelled && !isStopping) cursorSampler.stop();
    releaseLease();
    exitPromiseResolve({ code, signal: sig, stderr: stderrBuffer });
  });

  return {
    jobId,
    pid,
    outputPath,
    encoder,
    startedAtMs,
    getCaptureT0Ms: () => captureT0Ms || startedAtMs,
    getSamplerStartedAtMs: () => (cursorSampler ? cursorSampler.startedAtWallClockMs : null),
    getTelemetry: () => (cursorSampler ? cursorSampler.toArray() : []),
    get isStopping() {
      return isStopping;
    },
    get isCancelled() {
      return isCancelled;
    },
    getLastError: () => lastError,
    onExit(cb) {
      if (typeof cb === 'function') exitPromise.then(cb);
      return exitPromise;
    },

    async stop({ waitMs = 10000 } = {}) {
      if (isStopping) return exitPromise;
      isStopping = true;

      const rawTelemetry = cursorSampler ? cursorSampler.stop() : [];

      // Send SIGINT to the process group (macOS / Linux) or direct pid
      try {
        killImpl(-pid, 'SIGINT');
      } catch {
        try { child.kill?.('SIGINT'); } catch { /* ignore */ }
      }
      try { child.kill?.('SIGINT'); } catch { /* ignore */ }

      // Hard limit of waitMs before kill escalation
      const hardEscalate = setTimeout(() => {
        try {
          governor.cancelProcessTree(pid, { killAfterMs: 2000, killImpl, livenessImpl });
        } catch { /* ignore */ }
        try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
      }, waitMs);
      if (hardEscalate && typeof hardEscalate.unref === 'function') hardEscalate.unref();

      let stopTimeout;
      const exitResult = await Promise.race([
        exitPromise,
        new Promise((r) => { stopTimeout = setTimeout(() => r({ code: 1, signal: 'SIGKILL' }), waitMs + 2500); }),
      ]);
      clearTimeout(hardEscalate);
      if (stopTimeout) clearTimeout(stopTimeout);

      // NOTE: the lease is released by the child 'exit' handler once the process
      // is actually gone. Releasing here on a wait timeout would free the heavy
      // slot while FFmpeg is still running (item 10).

      // Exit code 0 or 255 (SIGINT exit in FFmpeg) counts as a candidate success
      // if output file exists. The bridge confirms the file with ffprobe before
      // marking the job done.
      let micWarning = null;
      let micPath = null;
      if (useHelper && exitResult.code === 0 && helperStopped?.micPath && fs.existsSync(helperStopped.micPath)) {
        try {
          ({ micPath } = await prepareMicrophoneTrack({
            micPath: helperStopped.micPath,
            micOffsetMs: helperStopped.micOffsetMs || 0,
            ffmpegBinary,
            governor,
            jobId,
          }));
        } catch (err) {
          micWarning = err.message;
        }
      }

      const fileExists = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
      if (fileExists && (exitResult.code === 0 || exitResult.code === 255 || exitResult.signal === 'SIGINT')) {
        return {
          ok: true,
          outputPath,
          telemetry: rawTelemetry,
          captureT0Ms: captureT0Ms || startedAtMs,
          samplerStartedAtMs: cursorSampler ? cursorSampler.startedAtWallClockMs : null,
          durationSec: Math.round((Date.now() - startedAtMs) / 1000),
          fileSize: fs.statSync(outputPath).size,
          micPath,
          ...(micWarning ? { warning: `Mikrofon nie został zapisany: ${micWarning}` } : {}),
        };
      }

      return {
        ok: false,
        error: lastError
          ? `Recording failed: ${lastError}`
          : `Recording finished with non-zero exit code (${exitResult.code}) or missing output file.`,
        code: 'ERECORD_FAILED',
        stderr: stderrBuffer.slice(-2000),
      };
    },

    async cancel({ waitMs = 5000 } = {}) {
      if (isCancelled) return { ok: false, cancelled: true };
      isCancelled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);

      if (cursorSampler) cursorSampler.stop();

      // Let the helper stop its ScreenCaptureKit stream cleanly before any kill,
      // so the system never keeps capturing for a vanished client.
      if (useHelper) {
        try { killImpl(-pid, 'SIGINT'); } catch { try { child.kill?.('SIGINT'); } catch { /* gone */ } }
        let graceTimer;
        await Promise.race([
          exitPromise,
          new Promise((r) => { graceTimer = setTimeout(r, 3000); }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      }

      try {
        governor.cancelProcessTree(pid, { killAfterMs: 1000, killImpl, livenessImpl });
      } catch { /* ignore */ }
      try {
        child.kill?.('SIGKILL');
      } catch { /* ignore */ }

      let cancelTimer;
      await Promise.race([
        exitPromise,
        new Promise((r) => { cancelTimer = setTimeout(r, waitMs); }),
      ]);
      if (cancelTimer) clearTimeout(cancelTimer);
      releaseLease();

      // Delete output file (and the helper's microphone sidecar)
      for (const file of [outputPath, micSidecarPath]) {
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch { /* ignore */ }
      }

      return { ok: false, cancelled: true };
    },
  };
}
