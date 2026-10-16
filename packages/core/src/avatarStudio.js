import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveFfmpegBinary } from './rendererAdapter.js';
import { runGovernedFfmpeg, runGovernedProcess } from './governedProcess.js';
import { selectH264Encoder, tryProbeFfmpegCapabilities } from './ffmpegCapabilities.js';

export const AVATAR_ENGINES = {
  LIVEPORTRAIT_MPS: 'liveportrait_mps', // Metal Performance Shaders / Apple Silicon
  CUTOUT_2D_FALLBACK: 'cutout_2d_fallback', // Zero-VRAM 2D mascot
  WAV2LIP_RESTRICTED: 'wav2lip_restricted',
};

export const ALPHA_OUTPUT_FORMATS = ['prores4444', 'webp_sequence', 'png_sequence'];

/**
 * Checks model and code licensing compliance for commercial video production.
 * Flags and blocks non-commercial models like standard Wav2Lip and unverified LivePortrait InsightFace dependencies.
 */
export function auditAvatarModelLicense(engineId) {
  if (engineId === AVATAR_ENGINES.WAV2LIP_RESTRICTED || engineId === 'wav2lip') {
    return {
      commercialAllowed: false,
      license: 'Non-Commercial Research Use Only',
      reason: 'Wav2Lip code and checkpoints contain non-commercial academic restrictions and cannot be bundled into commercial product.',
      recommendedAction: 'Use Cutout 2D Mascot Fallback or verify permissive commercial lipsync checkpoints.',
    };
  }

  if (engineId === AVATAR_ENGINES.LIVEPORTRAIT_MPS || engineId === 'liveportrait') {
    return {
      commercialAllowed: false,
      license: 'Pending Dependency & Weights Audit (InsightFace Restrictive)',
      reason: 'LivePortrait utilizes InsightFace dependencies (which carry non-commercial research restrictions on standard pretrained models like buffalo_l) and third-party weight checkpoints. In strict adherence to Rule 7, commercial usage fails closed until individual weights, landmark detectors, and hardware benchmarks are audited and cleared.',
      recommendedAction: 'Use Zero-VRAM 2D Mascot Fallback or verify permissive face landmark models.',
    };
  }

  if (engineId === AVATAR_ENGINES.CUTOUT_2D_FALLBACK || engineId === '2d_mascot') {
    return {
      commercialAllowed: true,
      license: 'Proprietary Vidmyo / Apache-2.0',
      reason: '100% locally rendered deterministic 2D vector animation with zero-VRAM footprint.',
    };
  }

  return {
    commercialAllowed: false,
    license: 'Unknown',
    reason: `Unverified avatar engine: ${engineId}`,
  };
}

/**
 * Generates transparent alpha compositing parameters for talking avatar.
 */
export function createAvatarAlphaPipeline({
  sourceImagePath,
  audioPath,
  outputFormat = 'prores4444',
  engine = AVATAR_ENGINES.LIVEPORTRAIT_MPS,
  dimensions = { width: 720, height: 720 },
} = {}) {
  if (!sourceImagePath || !audioPath) {
    throw new Error('sourceImagePath and audioPath are required for avatar pipeline');
  }

  // Enforce license verification gate
  const licenseAudit = auditAvatarModelLicense(engine);
  if (!licenseAudit.commercialAllowed) {
    throw new Error(`Commercial license gate rejected engine '${engine}': ${licenseAudit.reason}`);
  }

  if (!ALPHA_OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`Unsupported alpha format: ${outputFormat}`);
  }

  const pipeline = {
    engine,
    sourceImagePath,
    audioPath,
    outputFormat,
    dimensions,
    supportsAlphaChannel: true,
    ffmpegPixelFormat: outputFormat === 'prores4444' ? 'yuva444p10le' : 'rgba',
    governorClass: 'heavy',
    estimatedVramGb: engine === AVATAR_ENGINES.LIVEPORTRAIT_MPS ? 1.6 : 0.1,
  };

  return pipeline;
}

/**
 * Fallback 2D mascot avatar generator with audio-amplitude lip animation.
 * Zero-VRAM requirement, renders deterministically in any environment.
 */
export function generate2dMascotAvatar({
  characterName = 'Vidmyo Mascot',
  audioDurationSec = 5.0,
  headShape = 'circle',
  color = '#7c3aed',
  amplitudeEnvelope = [],
}) {
  return {
    engine: AVATAR_ENGINES.CUTOUT_2D_FALLBACK,
    characterName,
    headShape,
    color,
    audioDurationSec,
    mouthStates: amplitudeEnvelope.map((sample, idx) => ({
      frame: idx,
      openness: sample.mouthOpenness || 0,
    })),
    supportsAlpha: true,
    renderComplexity: 'zero_vram',
  };
}

/**
 * Reads a supplied narration audio file, decodes raw 16-bit PCM via FFmpeg,
 * probes true audio duration, computes a per-frame RMS amplitude envelope,
 * and derives mouthStates (openness [0.0 - 1.0]) for dynamic mouth animation.
 */
export function extractAudioEnvelope(audioPath, {
  fps = 30,
  sampleRate = 16000,
  ffmpegBinary = null,
} = {}) {
  if (!audioPath) {
    throw new Error('audioPath is required to extract audio envelope');
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Supplied audio file not found: ${audioPath}`);
  }

  const binary = resolveFfmpegBinary(ffmpegBinary);
  // Decode audio into mono 16-bit little-endian PCM at sampleRate
  const proc = spawnSync(binary, [
    '-y',
    '-i', audioPath,
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 's16le',
    'pipe:1',
  ], { maxBuffer: 100 * 1024 * 1024 });

  if (proc.status !== 0 || !proc.stdout || proc.stdout.length === 0) {
    throw new Error(`FFmpeg failed to decode audio from ${audioPath}: ${proc.stderr?.toString()?.slice(-400)}`);
  }

  return processPcmAudioBuffer(proc.stdout, { sampleRate, fps, audioPath });
}

/**
 * Async governed variant of extractAudioEnvelope.
 * Runs under ResourceGovernor with light class and capped stdout buffer.
 */
export async function extractAudioEnvelopeAsync(audioPath, {
  sampleRate = 8000,
  fps = 30,
  ffmpegBinary = null,
  governor = null,
  jobId = null,
  signal = null,
  timeoutMs = 30000,
  maxDurationSec = null,
} = {}) {
  if (typeof audioPath !== 'string' || !audioPath.trim()) {
    throw new Error('extractAudioEnvelopeAsync requires a valid audioPath string');
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Supplied audio file not found: ${audioPath}`);
  }

  const binary = resolveFfmpegBinary(ffmpegBinary);
  const capBytes = maxDurationSec && maxDurationSec > 0
    ? Math.min(100 * 1024 * 1024, Math.max(1024 * 1024, Math.ceil(maxDurationSec * sampleRate * 4)))
    : 100 * 1024 * 1024;

  const result = await runGovernedProcess({
    cmd: binary,
    args: [
      '-y',
      '-i', audioPath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      'pipe:1',
    ],
    governor,
    jobId,
    signal,
    timeoutMs,
    resourceClass: 'light',
    waitForSlotMs: 5000,
    captureStdout: { maxBytes: capBytes },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.exitCode !== 0 || !result.stdout || result.stdout.length === 0) {
    throw new Error(`FFmpeg failed to decode audio from ${audioPath}: ${(result.stderr || '').slice(-400)}`);
  }

  return processPcmAudioBuffer(result.stdout, { sampleRate, fps, audioPath });
}

export function processPcmAudioBuffer(rawBuffer, { sampleRate, fps, audioPath }) {
  const sampleCount = Math.floor(rawBuffer.length / 2);
  const samples = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, sampleCount);
  const durationSec = sampleCount / sampleRate;

  if (durationSec <= 0) {
    throw new Error(`Decoded audio stream has zero length: ${audioPath}`);
  }

  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const samplesPerFrame = sampleRate / fps;

  // 1. Calculate RMS per frame window
  const frameRmsList = [];
  let peakRms = 0.0001;
  for (let f = 0; f < totalFrames; f++) {
    const startIdx = Math.floor(f * samplesPerFrame);
    const endIdx = Math.min(sampleCount, Math.floor((f + 1) * samplesPerFrame));
    const count = endIdx - startIdx;
    if (count <= 0) {
      frameRmsList.push(0);
      continue;
    }
    let sumSq = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const norm = samples[i] / 32768.0;
      sumSq += norm * norm;
    }
    const rms = Math.sqrt(sumSq / count);
    frameRmsList.push(rms);
    if (rms > peakRms) peakRms = rms;
  }

  // 2. Derive mouth openness [0.0 - 1.0] from RMS relative to speech silence/activity
  const silenceFloor = 0.01;
  const effectiveDynamicRange = Math.max(0.03, peakRms - silenceFloor);
  const envelope = [];
  const mouthStates = [];

  for (let f = 0; f < totalFrames; f++) {
    const rms = frameRmsList[f];
    let openness = 0.0;
    if (rms > silenceFloor) {
      const normalized = (rms - silenceFloor) / effectiveDynamicRange;
      openness = Math.min(1.0, Math.max(0.0, normalized));
    }
    const frameData = {
      frame: f,
      timeSec: f / fps,
      rms: parseFloat(rms.toFixed(4)),
      openness: parseFloat(openness.toFixed(3)),
    };
    envelope.push(frameData);
    mouthStates.push(frameData);
  }

  return {
    durationSec,
    totalFrames,
    fps,
    sampleRate,
    peakRms: parseFloat(peakRms.toFixed(4)),
    envelope,
    mouthStates,
  };
}

/**
 * Renders a real MP4 video of the 2D mascot avatar using FFmpeg with amplitude-driven mouth animation
 * and real audio mixing (or audible voice synth tone).
 */
export async function render2dMascotVideo(mascotConfig, outputPath, {
  fps = 30,
  width = 720,
  height = 720,
  audioPath = null,
  amplitudeEnvelope = null,
  mouthStates = null,
  ffmpegBinary = null,
  onSpawn = null,
  // Phase 3 item 2: the render runs through the Phase 2 governed-process
  // helper, so cancel kills the whole process group (grandchildren included)
  // and the governor lease is released only after the child exits.
  governor = null,
  jobId = null,
  signal = null,
  spawnImpl = undefined,
  resourceClass = 'heavy',
  waitForSlotMs = 5000,
  timeoutMs = null,
  encoderOverride = null,
  capabilities = null,
} = {}) {
  if (governor && !jobId) {
    throw new Error('render2dMascotVideo requires jobId when a governor is provided');
  }
  const binary = resolveFfmpegBinary(ffmpegBinary);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const headColor = mascotConfig.color || '#7c3aed';

  // Handle audio input, duration probe, and envelope derivation
  let resolvedDurationSec = mascotConfig.audioDurationSec || 5.0;
  let resolvedMouthStates = mouthStates || amplitudeEnvelope || mascotConfig.mouthStates || mascotConfig.amplitudeEnvelope || null;
  let audioSourceType = 'synthetic_tone';

  if (audioPath) {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Supplied audio file not found: ${audioPath}`);
    }
    audioSourceType = 'real_narration_file';

    // If envelope not pre-computed, extract it directly from the real narration file
    if (!resolvedMouthStates || (Array.isArray(resolvedMouthStates) && resolvedMouthStates.length === 0)) {
      const extracted = await extractAudioEnvelopeAsync(audioPath, {
        fps,
        ffmpegBinary: binary,
        governor,
        jobId,
        signal,
      });
      resolvedDurationSec = extracted.durationSec;
      resolvedMouthStates = extracted.mouthStates;
    } else {
      // Probed audio duration from decoded audio
      try {
        const extracted = await extractAudioEnvelopeAsync(audioPath, {
          fps,
          ffmpegBinary: binary,
          governor,
          jobId,
          signal,
        });
        resolvedDurationSec = extracted.durationSec;
      } catch {
        // keep mascotConfig.audioDurationSec if extraction fails
      }
    }
  } else {
    // When no audio was requested, explicitly label as synthetic tone
    audioSourceType = 'synthetic_tone';
  }

  const durationSec = resolvedDurationSec;

  // Segment the duration into mouth animation keyframes/intervals
  const intervals = [];
  if (Array.isArray(resolvedMouthStates) && resolvedMouthStates.length > 0) {
    const stepSec = durationSec / resolvedMouthStates.length;
    for (let i = 0; i < resolvedMouthStates.length; i++) {
      const sample = resolvedMouthStates[i];
      const openness = typeof sample === 'number'
        ? sample
        : (sample.openness ?? sample.mouthOpenness ?? sample.amplitude ?? 0);
      const startSec = i * stepSec;
      const endSec = Math.min(durationSec, (i + 1) * stepSec);
      intervals.push({ startSec, endSec, openness });
    }
  } else {
    // Generate rhythmic speech viseme cadence: alternating open, half-open, closed
    const syllableRateHz = 3.5;
    const intervalSec = 1 / syllableRateHz;
    let t = 0;
    while (t < durationSec) {
      const segEnd = Math.min(durationSec, t + intervalSec);
      const phase = (t * syllableRateHz) % 1.0;
      let openness = 0.0;
      if (phase < 0.25) openness = 0.1;
      else if (phase < 0.6) openness = 0.85;
      else if (phase < 0.85) openness = 0.45;
      else openness = 0.05;
      intervals.push({ startSec: t, endSec: segEnd, openness });
      t = segEnd;
    }
  }

  // Merge consecutive intervals with identical mouth level to optimize filtergraph
  const quantized = intervals.map(int => {
    let level = 'closed';
    let h = 8;
    if (int.openness > 0.6) {
      level = 'open';
      h = 34;
    } else if (int.openness > 0.25) {
      level = 'half';
      h = 20;
    }
    return { ...int, level, h };
  });

  const merged = [];
  for (const q of quantized) {
    const prev = merged[merged.length - 1];
    if (prev && prev.level === q.level) {
      prev.endSec = q.endSec;
    } else {
      merged.push({ ...q });
    }
  }

  // Construct FFmpeg filter_complex with dynamic mouth animation keyed to speech amplitude
  const filterParts = [
    `color=c=#0f172a:s=${width}x${height}:r=${fps}:d=${durationSec}[bg]`,
    `[bg]drawbox=x=(w-200)/2:y=(h-200)/2:w=200:h=200:color=${headColor}@1:t=fill[head]`,
    `[head]drawbox=x=(w-100)/2:y=(h-50)/2:w=20:h=20:color=white@1:t=fill[eye_l]`,
    `[eye_l]drawbox=x=(w+60)/2:y=(h-50)/2:w=20:h=20:color=white@1:t=fill[eyes]`,
  ];

  let currentStage = 'eyes';
  for (let idx = 0; idx < merged.length; idx++) {
    const seg = merged[idx];
    const nextStage = `m_${idx}`;
    const my = Math.round((height + 60) / 2 + (34 - seg.h) / 2);
    filterParts.push(
      `[${currentStage}]drawbox=x=(w-60)/2:y=${my}:w=60:h=${seg.h}:color=#1e1b4b@1:t=fill:enable='between(t,${seg.startSec.toFixed(3)},${seg.endSec.toFixed(3)})'[${nextStage}]`
    );
    currentStage = nextStage;
  }

  const filterComplex = filterParts.join(';');

  // Mix real audio if provided, otherwise generate audible synthetic tone
  const audioInputArgs = audioPath
    ? ['-i', audioPath]
    : ['-f', 'lavfi', '-i', `sine=frequency=220:duration=${durationSec}`];

  const caps = capabilities || (ffmpegBinary ? { encoders: { libx264: true } } : tryProbeFfmpegCapabilities({ ffmpegPath: binary }).report);
  const encoderSelection = selectH264Encoder(caps, {
    isPreview: false,
    height,
    override: encoderOverride,
  });

  const args = [
    '-y',
    '-filter_complex', filterComplex,
    ...audioInputArgs,
    '-map', `[${currentStage}]`,
    '-map', '0:a',
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
      jobId,
      resourceClass,
      cmd: binary,
      args,
      governor,
      signal,
      spawnImpl,
      stdio: ['ignore', 'ignore', 'pipe'],
      waitForSlotMs,
      timeoutMs,
      onSpawn,
    });
  } catch (err) {
    const stderrTail = err.stderr ? String(err.stderr).slice(-800) : '';
    if (err.code === 'ECANCELLED') {
      const cancelled = new Error(
        `2D mascot render cancelled${stderrTail ? `: ${stderrTail}` : ''}`,
      );
      cancelled.code = 'ECANCELLED';
      cancelled.stderr = err.stderr || '';
      cancelled.cause = err;
      throw cancelled;
    }
    if (err.code === 'EEXIT') {
      const failed = new Error(
        `FFmpeg 2D mascot render failed with code ${err.exitCode}: ${stderrTail}`,
      );
      failed.code = 'EEXIT';
      failed.stderr = err.stderr || '';
      failed.cause = err;
      throw failed;
    }
    err.stderr = err.stderr || '';
    throw err;
  }

  if (!run || !fs.existsSync(outputPath)) {
    const reason = run ? 'produced no output file' : 'did not run';
    const err = new Error(`FFmpeg 2D mascot render failed (${reason}): ${outputPath}`);
    err.code = 'ENOOUTPUT';
    throw err;
  }

  return {
    ok: true,
    outputPath,
    durationSec,
    dimensions: { width, height },
    mouthKeyframeCount: merged.length,
    audioSource: audioSourceType,
    hasAnimatedMouth: true,
    encoder: { name: encoderSelection.name, reason: encoderSelection.reason },
    pid: run.pid,
    stderr: run.stderr || '',
  };
}

