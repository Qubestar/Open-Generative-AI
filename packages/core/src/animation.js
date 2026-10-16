import { characterAnimationMode, validateCharacters } from './stickman.js';
export { speechEnvelopeFromPcm } from './stickman.js';
import crypto from 'node:crypto';
import { DEFAULT_KOKORO_VOICE, kokoroVoice } from './kokoroVoices.js';
import { ANIMATION_STYLES, animationStyle } from './animationCatalog.js';

export { ANIMATION_STYLES, animationStyle } from './animationCatalog.js';

export const CREATIVE_STATES = [
  'draft', 'writing', 'review-script', 'voiceover', 'review-voiceover',
  'planning', 'images', 'flow-images', 'rendering', 'done', 'error', 'cancelled', 'interrupted',
];

const TRANSIENT_STATES = new Set(['writing', 'voiceover', 'planning', 'images', 'rendering']);
const PROVIDER_IDS = new Set(['codex', 'claude_code', 'gemini', 'hermes', 'openrouter']);
const ASPECTS = new Set(['16:9', '9:16']);
const STYLE_IDS = new Set(ANIMATION_STYLES.map((style) => style.id));
const SAFE_LAYER_KINDS = new Set(['hero', 'support', 'foreground']);

function boundedText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizedSourceSheet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, max] of Object.entries({
    sheetId: 256, spreadsheetTitle: 500, tab: 500, row: 64, title: 500,
    status: 200, videoNum: 100, hook: 4000, topic: 500, description: 10000,
    via: 80, url: 2000,
  })) {
    if (value[key] !== undefined && value[key] !== null) result[key] = boundedText(value[key], max);
  }
  return Object.keys(result).length ? result : undefined;
}

export function validateCreativeBrief(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The video brief is invalid.');
  const kind = input.kind === 'animation' ? 'animation' : input.kind === 'story' ? 'story' : null;
  if (!kind) throw new Error('Choose Story or Animations.');
  const style = kind === 'animation' ? animationStyle(input.style).id : 'doodle-v1';
  const topic = boundedText(input.topic, 300);
  const details = boundedText(input.details, 10000);
  if (!topic) throw new Error('Add a topic (up to 300 characters).');
  if (!ASPECTS.has(input.aspect)) throw new Error('Choose landscape or portrait.');
  const durationSec = Number(input.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 900) {
    throw new Error('Duration must be between 5 and 900 seconds.');
  }
  const provider = input.provider && typeof input.provider === 'object' ? input.provider : {};
  if (!PROVIDER_IDS.has(provider.id)) throw new Error('Choose a connected agent or API.');
  const model = provider.id === 'openrouter' ? boundedText(provider.model, 256) : 'configured-default';
  if (provider.id === 'openrouter' && !/^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new Error('Enter an OpenRouter model, such as provider/model.');
  }
  const language = boundedText(input.language || 'English', 80);
  if (!language) throw new Error('Enter a language.');
  const narrationDefault = style !== 'paper-stop-motion';
  const narration = input.narration === undefined ? narrationDefault : input.narration !== false;
  const isEnglish = /^(english|en)(-|$)/.test(language.toLowerCase().replaceAll('_', '-'));
  const voiceProvider = input.voiceProvider || (isEnglish ? 'kokoro' : 'elevenlabs');
  if (!['kokoro', 'elevenlabs', 'voicebox'].includes(voiceProvider)) throw new Error('Choose Local Kokoro, local Voicebox, or ElevenLabs for narration.');
  const voiceboxVoiceId = voiceProvider === 'voicebox' ? boundedText(input.voiceboxVoiceId, 128) : '';
  if (voiceProvider === 'voicebox' && narration && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(voiceboxVoiceId)) {
    throw new Error('Choose a Voicebox voice profile.');
  }
  const kokoroVoiceId = kokoroVoice(input.kokoroVoiceId || DEFAULT_KOKORO_VOICE).id;
  if (narration) creativeVoiceForLanguage(language, voiceProvider, kokoroVoiceId);
  const characterAnimation = kind === 'story' ? characterAnimationMode(input.characterAnimation) : 'static';
  const characterDesign = input.characterDesign || 'classic';
  if (!['classic', 'studio'].includes(characterDesign)) throw new Error('Choose a valid character design.');
  const sourceSheet = normalizedSourceSheet(input.sourceSheet);
  const sourceChannel = input.sourceChannel && typeof input.sourceChannel === 'object'
    && typeof input.sourceChannel.channelId === 'string' && typeof input.sourceChannel.videoId === 'string'
    ? { channelId: boundedText(input.sourceChannel.channelId, 160), videoId: boundedText(input.sourceChannel.videoId, 160) }
    : null;
  return {
    kind, style, topic, details, aspect: input.aspect, durationSec, language,
    provider: { id: provider.id, model },
    narration, voiceProvider, voiceboxVoiceId, kokoroVoiceId, characterAnimation, characterDesign,
    reviewScript: input.reviewScript === true,
    reviewVoiceover: narration && input.reviewVoiceover === true,
    imageSource: boundedText(input.imageSource, 80),
    imageModel: boundedText(input.imageModel, 256),
    script: boundedText(input.script, 30000),
    ...(sourceSheet ? { sourceSheet } : {}),
    ...(sourceChannel ? { sourceChannel } : {}),
  };
}

export function creativeVoiceForLanguage(language, provider = 'kokoro', voiceId = DEFAULT_KOKORO_VOICE) {
  const normalized = boundedText(language, 80).toLowerCase().replaceAll('_', '-');
  if (provider === 'elevenlabs') return { source: 'elevenlabs', voice: 'configured-default', model: 'eleven_multilingual_v2' };
  if (provider === 'voicebox') return { source: 'voicebox', voice: 'selected-profile' };
  if (/^(english|en)(-|$)/.test(normalized)) {
    const voice = kokoroVoice(voiceId);
    return { source: 'kokoro', voice: voice.id, lang: voice.lang };
  }
  throw new Error(
    `Local Kokoro narration supports English only; choose ElevenLabs for ${language || 'this language'}, or turn narration off.`,
  );
}

function normalizeLocations(value, sceneNumber) {
  if (!Array.isArray(value) || value.length > 5) throw new Error(`Scene ${sceneNumber} has invalid locations.`);
  return value.map((location) => {
    const name = boundedText(location?.name, 80);
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    if (!name || !Number.isFinite(lat) || Math.abs(lat) > 85 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error(`Scene ${sceneNumber} has an invalid map location.`);
    }
    return { name, lat, lon };
  });
}

function normalizeLayers(value, sceneNumber) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error(`Scene ${sceneNumber} has invalid visual layers.`);
  return value.map((layer) => {
    const kind = boundedText(layer?.kind, 20);
    const description = boundedText(layer?.description, 500);
    if (!SAFE_LAYER_KINDS.has(kind) || !description) throw new Error(`Scene ${sceneNumber} has an invalid visual layer.`);
    const asset = normalizeInternalAsset(layer?.asset, `Scene ${sceneNumber} layer`);
    const result = { kind, description, ...(asset ? { asset } : {}) };
    if (typeof layer?.assetFingerprint === 'string' && /^[a-f0-9]{64}$/.test(layer.assetFingerprint)) {
      result.assetFingerprint = layer.assetFingerprint;
    }
    if (typeof layer?.jobId === 'string' && /^job_[\w-]+$/.test(layer.jobId)) result.jobId = layer.jobId;
    return result;
  });
}

function normalizeInternalAsset(value, label = 'Scene') {
  if (value === undefined || value === null || value === '') return null;
  const asset = boundedText(value, 500).replaceAll('\\', '/');
  if (!asset || asset.startsWith('/') || /^[A-Za-z]:\//.test(asset) || asset.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`${label} has an unsafe asset path.`);
  }
  if (!/\.(?:png|jpe?g|webp)$/i.test(asset)) throw new Error(`${label} has an unsupported asset type.`);
  return asset;
}

export function validateAnimationPlan(plan, { expectedDurationSec = null, expectedSceneCount = null, style = null, characterAnimation = 'static' } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.scenes) || !plan.scenes.length || plan.scenes.length > 150) {
    throw new Error('The agent returned no usable scenes.');
  }
  if (expectedSceneCount !== null && plan.scenes.length !== expectedSceneCount) {
    throw new Error('The scene plan does not match the narration timing. Retry production.');
  }
  const cast = new Map();
  const scenes = plan.scenes.map((scene, index) => {
    const sceneNumber = index + 1;
    const expectedId = `s${String(sceneNumber).padStart(3, '0')}`;
    const id = boundedText(scene?.id || expectedId, 20);
    const headline = boundedText(scene?.headline, 100);
    const visual = boundedText(scene?.visual, 3000);
    const durationSec = Number(scene?.durationSec);
    if (id !== expectedId) throw new Error(`Scene ${sceneNumber} must use stable id ${expectedId}.`);
    if (!headline || !visual) throw new Error(`Scene ${sceneNumber} has an invalid headline or visual description.`);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 120) throw new Error(`Scene ${sceneNumber} has invalid timing.`);
    const locations = normalizeLocations(scene.locations ?? [], sceneNumber);
    if (style === 'documentary-map' && locations.length === 0) throw new Error(`Map scene ${sceneNumber} has no location.`);
    const layers = normalizeLayers(scene.layers, sceneNumber);
    if (style === 'documentary-map' && layers.length) throw new Error(`Map scene ${sceneNumber} cannot contain image layers.`);
    if (style === 'editorial-collage' || style === 'paper-stop-motion') {
      if (layers.length < 2) throw new Error(`Scene ${sceneNumber} needs a hero and at least one supporting visual layer.`);
      if (layers.filter((layer) => layer.kind === 'hero').length !== 1) {
        throw new Error(`Scene ${sceneNumber} must contain exactly one hero visual layer.`);
      }
    }
    if (characterAnimation === 'animated' && (layers.length || locations.length)) throw new Error('Animated Stickman uses separate characters and a background.');
    const characters = validateCharacters(scene.characters, { required: characterAnimation === 'animated' });
    // Lock appearance to the first occurrence; an agent cannot change an actor mid-film.
    for (const actor of characters) {
      if (!cast.has(actor.id)) cast.set(actor.id, {shirt:actor.shirt, skin:actor.skin});
      Object.assign(actor, cast.get(actor.id));
    }
    const result = { id, headline, visual, durationSec, locations, layers, ...(characters.length ? { characters } : {}) };
    const asset = normalizeInternalAsset(scene.asset, `Scene ${sceneNumber}`);
    if (asset) result.asset = asset;
    if (typeof scene.assetFingerprint === 'string' && /^[a-f0-9]{64}$/.test(scene.assetFingerprint)) result.assetFingerprint = scene.assetFingerprint;
    if (typeof scene.jobId === 'string' && /^job_[\w-]+$/.test(scene.jobId)) result.jobId = scene.jobId;
    return result;
  });
  if (expectedDurationSec !== null) {
    const sum = scenes.reduce((total, scene) => total + scene.durationSec, 0);
    const tolerance = Math.max(0.15, Number(expectedDurationSec) * 0.01);
    if (!Number.isFinite(expectedDurationSec) || Math.abs(sum - Number(expectedDurationSec)) > tolerance) {
      throw new Error('The scene plan does not cover the full video duration.');
    }
  }
  return { version: 1, scenes };
}

export function sceneIntervalsFromBeats(beats, audioDurationSec) {
  const duration = Number(audioDurationSec);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('The voiceover duration is invalid.');
  if (!Array.isArray(beats) || beats.length === 0) throw new Error('No narration timing was detected.');
  const normalized = beats.map((beat, index) => {
    const start = Number(beat?.start);
    const end = Number(beat?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.25) {
      throw new Error(`Narration beat ${index + 1} has invalid timing.`);
    }
    return { text: boundedText(beat.text, 4000), start, end };
  });
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].start < normalized[index - 1].end - 0.01) throw new Error('Narration beats overlap or are out of order.');
  }
  const boundaries = [0];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    boundaries.push((normalized[index].end + normalized[index + 1].start) / 2);
  }
  boundaries.push(duration);
  return normalized.map((beat, index) => ({
    id: `s${String(index + 1).padStart(3, '0')}`,
    text: beat.text,
    startSec: boundaries[index], endSec: boundaries[index + 1],
    durationSec: boundaries[index + 1] - boundaries[index],
  }));
}

export function allocateSceneFrames(scenes, totalDurationSec, fps = 30) {
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('Cannot render an empty scene plan.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('The render frame rate is invalid.');
  const duration = Number(totalDurationSec);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The render duration is invalid.');
  const totalFrames = Math.max(scenes.length, Math.ceil(duration * fps));
  const weights = scenes.map((scene) => Number(scene.durationSec));
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0 || weights.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('The scene plan has invalid timing.');
  }
  let cursor = 0;
  let cumulativeWeight = 0;
  return scenes.map((scene, index) => {
    cumulativeWeight += weights[index];
    const next = index === scenes.length - 1 ? totalFrames : Math.max(cursor + 1, Math.round(cumulativeWeight / totalWeight * totalFrames));
    const result = { ...scene, startFrame: cursor, frames: next - cursor };
    cursor = next;
    return result;
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function creativeFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function creativeSpecFingerprint(brief, script) {
  const { provider: _provider, imageSource: _imageSource, imageModel: _imageModel, reviewScript: _reviewScript,
    reviewVoiceover: _reviewVoiceover, sourceSheet: _sourceSheet, ...content } = brief;
  return creativeFingerprint({ brief: content, script: boundedText(script, 30000) });
}

export function creativeAssetFingerprint(style, aspect, scene, {
  imageSource = '', imageModel = '', layer = null, characterAnimation = 'static',
} = {}) {
  return creativeFingerprint({
    style,
    aspect,
    id: scene.id,
    ...(characterAnimation === 'animated' ? { characterAnimation, assetRole: 'background-only-v1' } : {}),
    imageSource: boundedText(imageSource, 80),
    imageModel: boundedText(imageModel, 256),
    target: layer
      ? { kind: boundedText(layer.kind, 20), description: boundedText(layer.description, 500) }
      : {
          kind: 'scene',
          visual: boundedText(scene.visual, 3000),
          layers: normalizeLayers(scene.layers, Number(String(scene.id || '').replace(/^s/, '')) || 1)
            .map(({ kind, description }) => ({ kind, description })),
        },
  });
}

export function wavDurationSeconds(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The voiceover is not a valid WAV file.');
  }
  let offset = 12;
  let bytesPerSecond = 0;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > buffer.length - body) throw new Error('The voiceover WAV file is truncated.');
    if (id === 'fmt ' && size >= 16) bytesPerSecond = buffer.readUInt32LE(body + 8);
    if (id === 'data') dataBytes = size;
    offset = body + size + (size % 2);
  }
  const duration = Number(dataBytes) / Number(bytesPerSecond);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('The voiceover WAV duration is invalid.');
  return duration;
}

export function normalizeCreativeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('This project manifest is invalid.');
  if (manifest.version !== 1) throw new Error(`Unsupported manifest version ${manifest.version}.`);
  const prior = manifest.brief && typeof manifest.brief === 'object' ? manifest.brief : {};
  const kind = prior.kind === 'animation' || STYLE_IDS.has(manifest.style) ? 'animation' : 'story';
  const style = kind === 'animation' && STYLE_IDS.has(prior.style || manifest.style) ? prior.style || manifest.style : 'doodle-v1';
  const sourceSheet = normalizedSourceSheet(prior.sourceSheet);
  manifest.brief = {
    ...prior, kind, style,
    topic: boundedText(prior.topic || prior.title || manifest.name || 'Untitled video', 300),
    details: boundedText(prior.details || [prior.hook, prior.angle, prior.cta].filter(Boolean).join('\n'), 10000),
    aspect: ASPECTS.has(prior.aspect || manifest.aspect) ? prior.aspect || manifest.aspect : '16:9',
    durationSec: Number.isFinite(Number(prior.durationSec)) ? Number(prior.durationSec) : 300,
    language: boundedText(prior.language || 'English', 80),
    provider: prior.provider && typeof prior.provider === 'object' ? prior.provider : { id: '', model: '' },
    narration: prior.narration !== false,
    characterAnimation: kind === 'story' ? characterAnimationMode(prior.characterAnimation) : 'static',
    characterDesign: prior.characterDesign === 'studio' ? 'studio' : 'classic',
    voiceProvider: ['kokoro', 'elevenlabs', 'voicebox'].includes(prior.voiceProvider)
      ? prior.voiceProvider
      : (/^(english|en)(-|$)/.test(boundedText(prior.language || 'English', 80).toLowerCase().replaceAll('_', '-')) ? 'kokoro' : 'elevenlabs'),
    kokoroVoiceId: prior.kokoroVoiceId || DEFAULT_KOKORO_VOICE,
    voiceboxVoiceId: prior.voiceProvider === 'voicebox' ? boundedText(prior.voiceboxVoiceId, 128) : '',
    reviewScript: prior.reviewScript === true,
    reviewVoiceover: prior.reviewVoiceover === true,
    imageSource: boundedText(prior.imageSource, 80), imageModel: boundedText(prior.imageModel, 256),
    script: boundedText(prior.script || manifest.script, 30000),
    ...(sourceSheet ? { sourceSheet } : {}),
  };
  manifest.style = style;
  manifest.aspect = manifest.brief.aspect;
  manifest.scenes = Array.isArray(manifest.scenes) ? manifest.scenes : [];
  manifest.renders = Array.isArray(manifest.renders) ? manifest.renders : [];
  manifest.voiceover = manifest.voiceover && typeof manifest.voiceover === 'object'
    ? { source: null, artifact: null, wordTimings: null, ...manifest.voiceover }
    : { source: null, artifact: null, wordTimings: null };
  const hadProduction = manifest.production && typeof manifest.production === 'object';
  const legacyRender = Array.isArray(manifest.renders) ? manifest.renders.at(-1) : null;
  const legacyOutput = boundedText(legacyRender?.finalPath || legacyRender?.path, 1000);
  const production = hadProduction ? manifest.production : legacyOutput ? {
    state: 'done', output: legacyOutput, message: 'Your video is ready',
  } : {};
  manifest.production = {
    ...production,
    state: CREATIVE_STATES.includes(production.state) ? production.state : 'draft',
    scriptApproved: production.scriptApproved === true,
    voiceApproved: production.voiceApproved === true,
  };
  return manifest;
}

export function markInterruptedProduction(manifest) {
  normalizeCreativeManifest(manifest);
  if (!TRANSIENT_STATES.has(manifest.production.state)) return false;
  manifest.production = {
    ...manifest.production, state: 'interrupted', resumeState: manifest.production.state,
    message: 'Production was interrupted. Continue to resume from saved work.',
  };
  return true;
}
