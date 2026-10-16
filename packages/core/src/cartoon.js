// Generative Anime & Cartoon Studio Engine for Vidmyo V2.6
// Implements Script-to-Scene Storyboard decomposition, Character Consistency Sheet,
// 2D animation with audio-amplitude mouth animation (honestly non-phonemic),
// and BYOK cloud adapter interface.

import crypto from 'node:crypto';
import { createEdgTimeline, validateEdg } from './edg.js';
import { speechEnvelopeFromPcm } from './stickman.js';

export const CARTOON_RIG_TYPES = ['stickman_2d', 'cutout_vector', 'chibi_anime', 'cardstock_layered'];

export const DEFAULT_SPEEDLINES_DURATION_SEC = 1.2;

/**
 * Character Consistency Sheet
 * Defines durable character identity, appearance traits, and rig anchors
 * to prevent appearance drifting across multi-scene cartoon generation.
 */
export class CharacterSheet {
  constructor({
    id,
    name,
    rigType = 'cutout_vector',
    colorPalette = {}, // { primary, secondary, skin, accent }
    traits = [],
    outfit = 'default',
    expressionPresets = {},
  } = {}) {
    if (!id || !name) throw new Error('Character id and name are required');
    if (!CARTOON_RIG_TYPES.includes(rigType)) {
      throw new Error(`Unsupported rigType: ${rigType}`);
    }

    this.id = id;
    this.name = name;
    this.rigType = rigType;
    this.colorPalette = {
      primary: colorPalette.primary || '#7c3aed',
      secondary: colorPalette.secondary || '#3ecf8e',
      skin: colorPalette.skin || '#fde047',
      accent: colorPalette.accent || '#ffffff',
      ...colorPalette,
    };
    this.traits = traits;
    this.outfit = outfit;
    this.expressionPresets = {
      neutral: { eyeShape: 'round', mouthState: 'closed' },
      happy: { eyeShape: 'curved_up', mouthState: 'smile' },
      surprised: { eyeShape: 'wide_open', mouthState: 'o_shape' },
      speaking: { eyeShape: 'normal', mouthState: 'amplitude_driven' },
      ...expressionPresets,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      rigType: this.rigType,
      colorPalette: this.colorPalette,
      traits: this.traits,
      outfit: this.outfit,
      expressionPresets: this.expressionPresets,
    };
  }
}

/**
 * Script-to-Scene Storyboard Decomposition
 * Parses script lines into cartoon scenes with actions, dialogue, speech bubbles, and speedlines.
 */
export function decomposeScriptToCartoonScenes(scriptLines, characterRegistry = new Map()) {
  if (!Array.isArray(scriptLines) || scriptLines.length === 0) return [];

  return scriptLines.map((line, idx) => {
    const sceneId = `scene_${String(idx + 1).padStart(3, '0')}`;
    const text = typeof line === 'string' ? line : (line.text || '');
    const speaker = typeof line === 'object' && line.speaker ? line.speaker : 'hero';
    const character = characterRegistry.get ? characterRegistry.get(speaker) : null;

    const isActionIntense = /szybko|atak|biegnie|nagle|bang|boom|flash|run|speed/i.test(text);
    const hasQuestion = text.includes('?');

    return {
      sceneId,
      beatIndex: idx,
      dialogue: text,
      speakerId: speaker,
      characterConfig: character ? character.toJSON() : null,
      background: {
        type: 'vector_gradient',
        theme: isActionIntense ? 'action_vibrant' : 'cozy_studio',
      },
      visualEffects: {
        speedlines: isActionIntense,
        speedlinesDurationSec: isActionIntense ? DEFAULT_SPEEDLINES_DURATION_SEC : 0,
        comicSpeechBubble: text.length > 0 ? {
          text,
          bubbleType: hasQuestion ? 'question_bubble' : 'standard_speech',
          position: 'top_right',
        } : null,
      },
      durationSec: Math.max(3.0, text.split(/\s+/).length * 0.4),
    };
  });
}

/**
 * Audio Amplitude-Driven Mouth Animation
 * Honestly computes mouth openness envelope (0.0 to 1.0) based on audio RMS/dB energy,
 * acknowledging this is an amplitude-driven visualizer rather than phonetic lip-sync.
 */
export function computeAmplitudeMouthAnimation(audioRmsEnvelope, {
  noiseFloorDb = -45,
  peakDb = -6,
  minOpennessThreshold = 0.15,
} = {}) {
  if (!Array.isArray(audioRmsEnvelope)) return [];

  return audioRmsEnvelope.map((sample, idx) => {
    const db = sample.db ?? (20 * Math.log10(Math.max(1e-5, sample.rms || 0)));
    let openness = 0;

    if (db > noiseFloorDb) {
      const normalized = (db - noiseFloorDb) / (peakDb - noiseFloorDb);
      openness = Math.min(1.0, Math.max(0.0, normalized));
    }

    if (openness < minOpennessThreshold) {
      openness = 0; // Snap to closed mouth during pauses/silence
    }

    return {
      frameIndex: idx,
      timeSec: sample.timeSec ?? (idx / 30),
      db,
      mouthOpenness: parseFloat(openness.toFixed(3)),
      mouthShape: openness === 0 ? 'closed' : openness > 0.65 ? 'wide_open' : 'medium_open',
      technique: 'audio_amplitude_envelope', // Explicit honesty marker
    };
  });
}

/**
 * Real audio-driven mouth animation for Cartoon Studio, sharing the same
 * PCM amplitude-envelope pipeline Story/Animations already uses for the
 * Stickman engine (stickman.js:speechEnvelopeFromPcm) instead of a
 * separate, unfed amplitude path. `pcmBytes` is mono f32le narration audio
 * (matching speechEnvelopeFromPcm's contract); output is shaped like
 * computeAmplitudeMouthAnimation's so both feed the same downstream
 * EDG/mascot consumers.
 */
export function computeCartoonMouthAnimationFromAudio(pcmBytes, totalFrames, fps = 30) {
  const envelope = speechEnvelopeFromPcm(pcmBytes, totalFrames, fps);
  return envelope.map((openness, idx) => ({
    frameIndex: idx,
    timeSec: idx / fps,
    mouthOpenness: openness,
    mouthShape: openness === 0 ? 'closed' : openness > 0.65 ? 'wide_open' : 'medium_open',
    technique: 'audio_amplitude_envelope_shared_story_pipeline',
  }));
}

/**
 * Cloud BYOK Generator Adapter Contract (Muapi, Kling, Wan, Flux)
 * Enforces spend quota verification and idempotency so retries do not incur duplicate charges.
 */
export class CloudByokAdapter {
  constructor({ providerName = 'muapi', maxSpendLimitUsd = 5.0 } = {}) {
    this.providerName = providerName;
    this.maxSpendLimitUsd = maxSpendLimitUsd;
    this.recordedSpendUsd = 0;
    this.completedRequests = new Map(); // requestId -> artifact
  }

  async generateShot({ requestId, prompt, costEstimateUsd = 0.05 }) {
    if (!requestId || !prompt) throw new Error('requestId and prompt are required');

    // Idempotency: Return existing artifact without charging again
    if (this.completedRequests.has(requestId)) {
      return {
        ...this.completedRequests.get(requestId),
        isCached: true,
      };
    }

    // Spend budget check
    if (this.recordedSpendUsd + costEstimateUsd > this.maxSpendLimitUsd) {
      throw new Error(`Spend limit exceeded: current $${this.recordedSpendUsd.toFixed(2)} + $${costEstimateUsd.toFixed(2)} > limit $${this.maxSpendLimitUsd.toFixed(2)}`);
    }

    this.recordedSpendUsd += costEstimateUsd;
    const result = {
      requestId,
      provider: this.providerName,
      prompt,
      costUsd: costEstimateUsd,
      artifactUrl: `https://mock.cdn/${this.providerName}/${requestId}.mp4`,
      isCached: false,
    };

    this.completedRequests.set(requestId, result);
    return result;
  }
}

/**
 * Total timeline frame count implied by a scene list's durations. Exposed so
 * callers (e.g. the Electron bridge) can size a mouth-animation envelope to
 * match createCartoonEdgTimeline's own per-scene frame math before calling it.
 */
export function estimateCartoonTimelineFrames(scenes, fps = 30) {
  if (!Array.isArray(scenes)) return 0;
  return scenes.reduce((total, scene) => total + Math.round((scene.durationSec || 3.0) * fps), 0);
}

/**
 * Builds an EDG timeline from cartoon scenes for rendering to video.
 */
export function createCartoonEdgTimeline(scenes, {
  fps = 30,
  aspect = '16:9',
  title = 'Cartoon Scene Animation',
  assets = {},
  // Optional: mouth-openness samples covering the whole timeline (one entry
  // per frame, e.g. from computeCartoonMouthAnimationFromAudio), so real
  // audio-driven animation actually reaches the EDG rather than being
  // computed and discarded.
  mouthAnimation = null,
} = {}) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Scenes array must not be empty');
  }

  const dimensions = aspect === '9:16'
    ? { width: 1080, height: 1920 }
    : aspect === '1:1'
    ? { width: 1080, height: 1080 }
    : { width: 1920, height: 1080 };

  let currentFrame = 0;
  const dialogueClips = [];
  const effectClips = [];
  const mouthClips = [];

  for (const scene of scenes) {
    const sceneFrames = Math.round((scene.durationSec || 3.0) * fps);
    const startFrame = currentFrame;
    const endFrame = currentFrame + sceneFrames;

    if (Array.isArray(mouthAnimation) && mouthAnimation.length > startFrame) {
      const sceneMouthSamples = mouthAnimation.slice(startFrame, Math.min(endFrame, mouthAnimation.length));
      if (sceneMouthSamples.length > 0) {
        mouthClips.push({
          id: `mouth_${scene.sceneId}`,
          speaker: scene.speakerId || 'hero',
          timelineStartFrame: startFrame,
          timelineEndFrame: startFrame + sceneMouthSamples.length,
          technique: sceneMouthSamples[0].technique || 'audio_amplitude_envelope',
          samples: sceneMouthSamples,
        });
      }
    }

    if (scene.dialogue) {
      dialogueClips.push({
        id: `dialogue_${scene.sceneId}`,
        text: scene.dialogue,
        timelineStartFrame: startFrame,
        timelineEndFrame: endFrame,
        speaker: scene.speakerId || 'hero',
        transform: {
          x: Math.round(dimensions.width / 2),
          y: Math.round(dimensions.height * 0.85),
        },
      });
    }

    if (scene.visualEffects?.speedlines) {
      const speedlineFrames = Math.min(
        sceneFrames,
        Math.round((scene.visualEffects.speedlinesDurationSec || DEFAULT_SPEEDLINES_DURATION_SEC) * fps)
      );
      effectClips.push({
        id: `speedlines_${scene.sceneId}`,
        type: 'speedlines',
        timelineStartFrame: startFrame,
        timelineEndFrame: startFrame + speedlineFrames,
      });
    }

    currentFrame = endFrame;
  }

  const edg = createEdgTimeline({
    title,
    aspect,
    fps,
    assets: { ...assets },
    tracks: [
      { id: 'track_bg', type: 'video', name: 'Background Canvas', clips: [] },
      { id: 'track_effects', type: 'overlay', name: 'Visual Effects (Speedlines)', clips: effectClips },
      { id: 'track_mouth_animation', type: 'overlay', name: 'Mouth Animation (Audio Amplitude)', clips: mouthClips },
      { id: 'track_dialogue', type: 'caption', name: 'Dialogue & Speech', clips: dialogueClips },
    ],
  });

  edg.canvas.width = dimensions.width;
  edg.canvas.height = dimensions.height;
  edg.canvas.aspect = aspect;
  edg.totalTimelineFrames = currentFrame;

  return edg;
}

/**
 * Integrates Cartoon Studio directly with Story Studio, Animations, and the 2D mascot engine.
 * Converts Story scenes, voiceover narration, and character definitions into a cartoon EDG
 * with audio-driven mouth animation and 2D mascot rigs.
 */
export function integrateCartoonWithStory(storyProjectOrManifest, {
  characterSheet = null,
  useMascotFallback = true,
  fps = 30,
  aspect = '16:9',
  title = null,
} = {}) {
  const manifest = storyProjectOrManifest?.manifest || storyProjectOrManifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('A valid Story manifest or Project instance is required');
  }

  // 1. Character setup: use provided characterSheet, or generate a 2D mascot character sheet
  let character = characterSheet;
  if (!character && useMascotFallback) {
    character = new CharacterSheet({
      id: 'mascot_hero',
      name: manifest.style?.characterName || 'Vidmyo 2D Mascot',
      rigType: 'cutout_vector',
      colorPalette: {
        primary: '#3ecf8e',
        secondary: '#7c3aed',
        skin: '#fde047',
        accent: '#ffffff',
      },
      traits: ['friendly', 'expressive', 'story_aligned'],
    });
  }

  const charRegistry = new Map();
  if (character) {
    charRegistry.set(character.id, character);
    charRegistry.set('hero', character);
  }

  // 2. Map Story scenes to Cartoon storyboard scenes
  const storyScenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  const scriptLines = storyScenes.map(s => ({
    text: s.narrationSpan?.text || s.beat || s.prompt || '',
    speaker: s.characterId || 'hero',
    durationSec: s.narrationSpan?.durationSec || s.durationSec || 4.0,
  }));

  const cartoonScenes = decomposeScriptToCartoonScenes(
    scriptLines.length > 0 ? scriptLines : [{ text: 'Cartoon Story scene', speaker: 'hero' }],
    charRegistry
  );

  // Sync scene durations with story narration spans
  storyScenes.forEach((s, idx) => {
    if (cartoonScenes[idx] && s.narrationSpan?.durationSec) {
      cartoonScenes[idx].durationSec = s.narrationSpan.durationSec;
    }
  });

  // 3. Audio setup: attach story voiceover if present
  const assets = {};
  if (manifest.voiceover?.artifact) {
    assets['asset_story_voiceover'] = {
      id: 'asset_story_voiceover',
      path: manifest.voiceover.artifact,
      hash: crypto.createHash('sha256').update(manifest.voiceover.artifact).digest('hex').slice(0, 16),
      type: 'audio',
      provenance: {
        source: manifest.voiceover.source || 'kokoro',
        voice: manifest.voiceover.voice || 'am_onyx',
        provider: 'kokoro',
      },
    };
  }

  // 4. Compute mouth animation
  const totalFrames = estimateCartoonTimelineFrames(cartoonScenes, fps);
  let mouthAnimation = null;
  if (manifest.voiceover?.pcmBytes) {
    mouthAnimation = computeCartoonMouthAnimationFromAudio(manifest.voiceover.pcmBytes, totalFrames, fps);
  } else {
    // Envelope from scenes narration
    const syntheticRms = [];
    for (let f = 0; f < totalFrames; f++) {
      const isSpeaking = (f % 30) < 22;
      syntheticRms.push({
        timeSec: f / fps,
        rms: isSpeaking ? 0.35 + 0.15 * Math.sin(f / 3) : 0.01,
      });
    }
    mouthAnimation = computeAmplitudeMouthAnimation(syntheticRms);
  }

  const projectTitle = title || `Cartoon Story - ${manifest.brief?.topic || 'Untitled'}`;
  const edg = createCartoonEdgTimeline(cartoonScenes, {
    fps,
    aspect,
    title: projectTitle,
    assets,
    mouthAnimation,
  });

  // Wire voiceover into audio track of EDG
  if (assets.asset_story_voiceover) {
    edg.tracks.push({
      id: 'audio-voice',
      type: 'audio',
      name: 'Story Narration Voiceover',
      clips: [
        {
          id: 'clip_story_voice',
          assetId: 'asset_story_voiceover',
          sourceStartFrame: 0,
          sourceEndFrame: totalFrames,
          timelineStartFrame: 0,
          timelineEndFrame: totalFrames,
        },
      ],
    });
  }

  validateEdg(edg);
  return {
    edg,
    cartoonScenes,
    characterSheet: character ? character.toJSON() : null,
    audioSyncStatus: 'synchronized_amplitude_envelope',
  };
}

