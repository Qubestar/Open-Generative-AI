// Vidmyo AI Auto-Editor Engine for Vidmyo V2.6
// Implements Best Take Selector 2.0, separated silence/breath VAD vs ASR filler words,
// context-aware padding presets, event-driven punch-in zoom, and sidechain ducking.

export const PADDING_PRESETS_MS = {
  SPEECH_FILLER_SPEECH: { min: 80, max: 130, default: 100 },
  SPEECH_BREATH_SPEECH: { min: 120, max: 220, default: 150 },
  SENTENCE_TO_SENTENCE: { min: 200, max: 450, default: 300 },
  TOPIC_TRANSITION:     { min: 350, max: 800, default: 500 },
};

export const PUNCH_IN_ZOOM_LEVELS = [1.0, 1.08, 1.15, 1.22];

export const MAX_VISUAL_STAGNATION_SECONDS = 7.5; // Trigger zoom if static between 6-9s

export const DUCKING_PROFILE = {
  attackMs: 100,
  releaseMs: 500,
  depthDb: -18,
};

/**
 * Best Take Selector 2.0
 * Evaluates sentence repetitions and chooses the highest scoring take
 * considering fluency, completeness, confidence, and lack of stumbles.
 */
export function selectBestTakes(candidateTakes) {
  if (!Array.isArray(candidateTakes) || candidateTakes.length === 0) return [];

  // Group candidate takes by semantic sentence key or normalized text
  const groups = new Map();
  for (const take of candidateTakes) {
    const key = (take.normalizedText || take.text || '').toLowerCase().trim().replace(/[^\w\s]/g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(take);
  }

  const selected = [];

  for (const [key, takes] of groups.entries()) {
    if (takes.length === 1) {
      selected.push({ ...takes[0], isBestTake: true, takeRank: 1 });
      continue;
    }

    // Score multi-factor: fluency (0-1), completeness (0-1), confidence (0-1), negative stumble penalty
    const scored = takes.map(take => {
      const fluency = take.fluencyScore ?? 0.8;
      const completeness = take.isCompleteSentence !== false ? 1.0 : 0.4;
      const confidence = take.vocalConfidence ?? 0.75;
      const stumblePenalty = (take.stumbleCount || 0) * 0.25;
      const compositeScore = Math.max(0, (fluency * 0.35 + completeness * 0.35 + confidence * 0.30) - stumblePenalty);

      return {
        ...take,
        compositeScore,
      };
    });

    // Sort by composite score descending
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    // Pick top take as best take
    selected.push({
      ...scored[0],
      isBestTake: true,
      takeRank: 1,
      alternateTakes: scored.slice(1),
    });
  }

  return selected;
}

/**
 * Separates acoustic silence / breath detection (VAD) from lexical filler words (ASR tokens).
 */
export function classifyAudioGaps({ vadSegments = [], asrTokens = [], speechSegments = [] }) {
  const classifiedCuts = [];

  // 1. Process VAD dead silences & breaths
  for (const vad of vadSegments) {
    const durationMs = (vad.endSec - vad.startSec) * 1000;
    if (vad.isBreath) {
      classifiedCuts.push({
        type: 'breath',
        startSec: vad.startSec,
        endSec: vad.endSec,
        durationMs,
        paddingMs: PADDING_PRESETS_MS.SPEECH_BREATH_SPEECH.default,
        action: 'trim_with_padding',
      });
    } else if (durationMs >= 300) {
      classifiedCuts.push({
        type: 'dead_silence',
        startSec: vad.startSec,
        endSec: vad.endSec,
        durationMs,
        paddingMs: PADDING_PRESETS_MS.SENTENCE_TO_SENTENCE.default,
        action: 'cut',
      });
    }
  }

  // 2. Process ASR filler words ("yyyy", "eeee", "um", "uh", "hmmm")
  const FILLER_PATTERNS = /^(y+e*y*|e+e*|u+m+|u+h+|h+m+|like|you know)$/i;

  for (const tok of asrTokens) {
    const cleanWord = (tok.word || '').trim().replace(/[.,!?;]/g, '');
    if (FILLER_PATTERNS.test(cleanWord)) {
      const durationMs = (tok.endSec - tok.startSec) * 1000;
      classifiedCuts.push({
        type: 'filler_word',
        word: cleanWord,
        startSec: tok.startSec,
        endSec: tok.endSec,
        durationMs,
        paddingMs: PADDING_PRESETS_MS.SPEECH_FILLER_SPEECH.default,
        action: 'remove_token',
      });
    }
  }

  // Sort cuts chronologically
  classifiedCuts.sort((a, b) => a.startSec - b.startSec);
  return classifiedCuts;
}

/**
 * Calculates event-driven punch-in zoom points.
 * Triggers zoom changes on emphasis, questions, topics, or when visual stagnation exceeds 7.5s.
 */
export function calculatePunchInZooms(clips, { maxStagnationSec = MAX_VISUAL_STAGNATION_SECONDS } = {}) {
  const result = [];
  let currentZoomIdx = 0; // 0 = 1.0x (normal)
  let lastZoomChangeSec = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = clip.endSec - clip.startSec;
    let shouldZoom = false;

    // Check semantic triggers
    if (clip.isQuestion || clip.isClimax || clip.isTopicTransition || clip.hasEmphasis) {
      shouldZoom = true;
    } else if ((clip.endSec - lastZoomChangeSec) >= maxStagnationSec) {
      // Visual stagnation safeguard
      shouldZoom = true;
    }

    if (shouldZoom) {
      // Alternate between 1.08x, 1.15x, and back to 1.0x
      currentZoomIdx = (currentZoomIdx + 1) % PUNCH_IN_ZOOM_LEVELS.length;
      lastZoomChangeSec = clip.startSec;
    }

    result.push({
      clipIndex: i,
      startSec: clip.startSec,
      endSec: clip.endSec,
      zoomLevel: PUNCH_IN_ZOOM_LEVELS[currentZoomIdx],
      triggeredBy: shouldZoom ? (clip.isQuestion ? 'question' : clip.isTopicTransition ? 'topic' : 'stagnation_safeguard') : 'none',
    });
  }

  return result;
}

/**
 * Computes sidechain ducking curve for background music.
 */
export function computeSidechainDucking(voiceSegments, totalDurationSec, {
  attackMs = DUCKING_PROFILE.attackMs,
  releaseMs = DUCKING_PROFILE.releaseMs,
  depthDb = DUCKING_PROFILE.depthDb,
} = {}) {
  const duckingKeyframes = [];

  // When speech starts, duck volume down; when speech ends, return to normal (0 dB)
  for (const seg of voiceSegments) {
    duckingKeyframes.push({
      timeSec: Math.max(0, seg.startSec - (attackMs / 1000)),
      volumeDb: 0,
    });
    duckingKeyframes.push({
      timeSec: seg.startSec,
      volumeDb: depthDb,
    });
    duckingKeyframes.push({
      timeSec: seg.endSec,
      volumeDb: depthDb,
    });
    duckingKeyframes.push({
      timeSec: Math.min(totalDurationSec, seg.endSec + (releaseMs / 1000)),
      volumeDb: 0,
    });
  }

  duckingKeyframes.sort((a, b) => a.timeSec - b.timeSec);
  return duckingKeyframes;
}
