// Timebase and clock synchronization for Vidmyo V2.6
// Discrete frame clock with rational FPS, 48kHz audio sample clock,
// absolute boundary arithmetic, and VFR/PTS mapping.
// Eliminates compounding float rounding drift over long timelines.

export const DEFAULT_SAMPLE_RATE = 48000;

export const STANDARD_FPS = {
  FPS_24: Object.freeze({ num: 24, den: 1 }),
  FPS_25: Object.freeze({ num: 25, den: 1 }),
  FPS_30: Object.freeze({ num: 30, den: 1 }),
  FPS_60: Object.freeze({ num: 60, den: 1 }),
  NTSC_24: Object.freeze({ num: 24000, den: 1001 }),
  NTSC_30: Object.freeze({ num: 30000, den: 1001 }),
  NTSC_60: Object.freeze({ num: 60000, den: 1001 }),
};

export function parseFps(fps) {
  if (typeof fps === 'number') {
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error(`Invalid numeric FPS: ${fps}`);
    }
    // Match common NTSC ratios
    if (Math.abs(fps - 23.976) < 0.01) return STANDARD_FPS.NTSC_24;
    if (Math.abs(fps - 29.97) < 0.01) return STANDARD_FPS.NTSC_30;
    if (Math.abs(fps - 59.94) < 0.01) return STANDARD_FPS.NTSC_60;
    // Whole integers
    if (Number.isInteger(fps)) {
      return Object.freeze({ num: fps, den: 1 });
    }
    // Approximate as rational with max denominator 1001
    return Object.freeze({ num: Math.round(fps * 1000), den: 1000 });
  }

  if (typeof fps === 'object' && fps !== null) {
    const num = Number(fps.num);
    const den = Number(fps.den || 1);
    if (!Number.isInteger(num) || num <= 0 || !Number.isInteger(den) || den <= 0) {
      throw new Error(`Invalid rational FPS object: ${JSON.stringify(fps)}`);
    }
    return Object.freeze({ num, den });
  }

  throw new Error(`Unsupported FPS specification: ${fps}`);
}

export function rationalToNumber(fps) {
  const parsed = parseFps(fps);
  return parsed.num / parsed.den;
}

export function secondsToFrame(seconds, fps, rounding = 'round') {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid seconds value: ${seconds}`);
  }
  const { num, den } = parseFps(fps);
  // (seconds * num) / den
  const rawFrames = (seconds * num) / den;
  if (rounding === 'floor') return Math.floor(rawFrames);
  if (rounding === 'ceil') return Math.ceil(rawFrames);
  return Math.round(rawFrames);
}

export function frameToSeconds(frame, fps) {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`Invalid frame number: ${frame}`);
  }
  const { num, den } = parseFps(fps);
  return (frame * den) / num;
}

export function secondsToSamples(seconds, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid seconds value: ${seconds}`);
  }
  return Math.round(seconds * sampleRate);
}

export function samplesToSeconds(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!Number.isInteger(samples) || samples < 0) {
    throw new Error(`Invalid samples number: ${samples}`);
  }
  return samples / sampleRate;
}

export function frameToSamples(frame, fps, sampleRate = DEFAULT_SAMPLE_RATE) {
  const seconds = frameToSeconds(frame, fps);
  return Math.round(seconds * sampleRate);
}

export function samplesToFrame(samples, sampleRate = DEFAULT_SAMPLE_RATE, fps = STANDARD_FPS.FPS_30) {
  const seconds = samplesToSeconds(samples, sampleRate);
  return secondsToFrame(seconds, fps);
}

/**
 * Calculates discrete non-overlapping, contiguous frame boundaries from time segments.
 * Computes absolute boundaries at points rather than accumulating rounded durations.
 *
 * @param {Array<{durationSec?: number, startSec?: number, endSec?: number}>} segments
 * @param {object|number} fps
 * @returns {Array<{startFrame: number, endFrame: number, durationFrames: number, startSec: number, endSec: number}>}
 */
export function calculateAbsoluteBoundaries(segments, fps) {
  const parsedFps = parseFps(fps);
  const result = [];
  let currentAccumulatedSec = 0;
  let prevEndFrame = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let startSec;
    let endSec;

    if (seg.startSec !== undefined && seg.endSec !== undefined) {
      startSec = seg.startSec;
      endSec = seg.endSec;
    } else {
      const dur = seg.durationSec ?? (seg.endSec - seg.startSec);
      if (typeof dur !== 'number' || dur < 0) {
        throw new Error(`Invalid segment duration at index ${i}`);
      }
      startSec = currentAccumulatedSec;
      endSec = currentAccumulatedSec + dur;
      currentAccumulatedSec = endSec;
    }

    const startFrame = i === 0 ? secondsToFrame(startSec, parsedFps) : prevEndFrame;
    const endFrame = secondsToFrame(endSec, parsedFps);
    const durationFrames = Math.max(0, endFrame - startFrame);

    result.push({
      index: i,
      startFrame,
      endFrame,
      durationFrames,
      startSec: frameToSeconds(startFrame, parsedFps),
      endSec: frameToSeconds(endFrame, parsedFps),
      sourceSegment: seg,
    });

    prevEndFrame = endFrame;
  }

  return result;
}

/**
 * Maps variable frame rate (VFR) timestamps / presentation timestamps (PTS)
 * onto a fixed target timeline frame grid without drifting.
 */
export function mapPtsToOutputFrames(ptsSecondsList, targetFps) {
  const parsedFps = parseFps(targetFps);
  return ptsSecondsList.map((pts, idx) => ({
    sourceIndex: idx,
    ptsSeconds: pts,
    outputFrame: secondsToFrame(pts, parsedFps),
    outputSeconds: frameToSeconds(secondsToFrame(pts, parsedFps), parsedFps),
  }));
}

/**
 * 30-minute determinism & drift test.
 * Simulates an 1800-second timeline consisting of hundreds of cuts.
 * Compares absolute boundary conversion against naive cumulative float rounding.
 * Returns metrics proving zero compounding drift.
 */
export function verifyTimelineDrift(totalDurationSeconds = 1800, segmentDurations = [2.35, 4.12, 1.83, 5.07, 3.44], fps = STANDARD_FPS.FPS_30, sampleRate = DEFAULT_SAMPLE_RATE) {
  const parsedFps = parseFps(fps);
  const segments = [];
  let elapsed = 0;
  let idx = 0;

  while (elapsed < totalDurationSeconds) {
    const dur = segmentDurations[idx % segmentDurations.length];
    const actualDur = Math.min(dur, totalDurationSeconds - elapsed);
    segments.push({ durationSec: actualDur });
    elapsed += actualDur;
    idx++;
  }

  const boundaries = calculateAbsoluteBoundaries(segments, parsedFps);
  const totalFrames = boundaries.length > 0 ? boundaries[boundaries.length - 1].endFrame : 0;
  const expectedTotalFrames = secondsToFrame(totalDurationSeconds, parsedFps);

  // Measure naive cumulative float drift
  let naiveCumulativeFrames = 0;
  let maxFrameDiffAgainstNaive = 0;
  for (const seg of segments) {
    naiveCumulativeFrames += Math.round(seg.durationSec * rationalToNumber(parsedFps));
  }
  const naiveDrift = Math.abs(naiveCumulativeFrames - expectedTotalFrames);

  // Audio sync check across 10 sample points throughout 30 minutes
  const syncCheckpoints = [];
  const checkInterval = totalDurationSeconds / 10;
  let maxAudioVideoSyncErrorFrames = 0;

  for (let c = 0; c <= 10; c++) {
    const timeSec = c * checkInterval;
    const targetFrame = secondsToFrame(timeSec, parsedFps);
    const audioSample = secondsToSamples(timeSec, sampleRate);
    const frameFromAudio = samplesToFrame(audioSample, sampleRate, parsedFps);
    const diff = Math.abs(targetFrame - frameFromAudio);
    if (diff > maxAudioVideoSyncErrorFrames) {
      maxAudioVideoSyncErrorFrames = diff;
    }
    syncCheckpoints.push({
      timeSec,
      targetFrame,
      audioSample,
      frameFromAudio,
      diffFrames: diff,
    });
  }

  return {
    totalDurationSeconds,
    segmentCount: segments.length,
    fps: parsedFps,
    totalFrames,
    expectedTotalFrames,
    frameDriftAtEnd: Math.abs(totalFrames - expectedTotalFrames),
    naiveCumulativeDrift: naiveDrift,
    maxAudioVideoSyncErrorFrames,
    syncCheckpoints,
    passed: Math.abs(totalFrames - expectedTotalFrames) === 0 && maxAudioVideoSyncErrorFrames <= 1,
  };
}
