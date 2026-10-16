import { DEFAULT_KOKORO_VOICE } from '../../core/src/kokoroVoices.js';
import { CREATIVE_IMAGE_SOURCES as IMAGE_SOURCES } from '../../core/src/creativeImages.js';

export const AUTOMATIC_IMAGE_SOURCES = IMAGE_SOURCES.filter(source => !source.manual);
export const STORY_IMAGE_SOURCES = IMAGE_SOURCES;

const DEFAULT_IMAGE_SOURCE = AUTOMATIC_IMAGE_SOURCES.find(source => source.id === 'fal')
  || AUTOMATIC_IMAGE_SOURCES[0];

export function creativeBriefDefaults(kind) {
  const imageSource = kind === 'story'
    ? (IMAGE_SOURCES.find(source => source.id === 'flow') || DEFAULT_IMAGE_SOURCE)
    : DEFAULT_IMAGE_SOURCE;
  return {
    kind,
    characterAnimation: 'static',
    characterDesign: 'studio',
    style: kind === 'animation' ? 'editorial-collage' : 'doodle-v1',
    topic: '',
    details: '',
    aspect: '16:9',
    durationSec: kind === 'animation' ? 30 : 300,
    language: 'English',
    voiceProvider: 'kokoro',
    kokoroVoiceId: DEFAULT_KOKORO_VOICE,
    voiceboxVoiceId: '',
    provider: { id: 'codex', model: 'openai/gpt-5.1' },
    narration: true,
    reviewScript: false,
    reviewVoiceover: false,
    imageSource: imageSource?.id || '',
    imageModel: imageSource?.models?.[0]?.id || '',
    script: '',
    sourceSheet: null,
    sourceChannel: null,
  };
}

export function mergeCreativeBrief(kind, value = {}) {
  const base = creativeBriefDefaults(kind);
  return {
    ...base,
    ...value,
    kind,
    style: kind === 'story' ? 'doodle-v1' : (value.style || base.style),
    provider: { ...base.provider, ...(value.provider || {}) },
    durationSec: Number(value.durationSec || base.durationSec),
    narration: value.narration === undefined ? base.narration : value.narration !== false,
    reviewScript: !!value.reviewScript,
    reviewVoiceover: value.narration !== false && !!value.reviewVoiceover,
    voiceboxVoiceId: typeof value.voiceboxVoiceId === 'string' ? value.voiceboxVoiceId : base.voiceboxVoiceId,
    sourceChannel: value.sourceChannel && typeof value.sourceChannel === 'object' ? value.sourceChannel : null,
  };
}

export function creativeSectionNumbers(kind, style) {
  const story = kind === 'story';
  const hasImageCreation = story || style !== 'documentary-map';
  return {
    style: story ? null : 1,
    brief: story ? 1 : 2,
    format: story ? 2 : 3,
    director: story ? 3 : 4,
    imageCreation: hasImageCreation ? (story ? 4 : 5) : null,
    reviewStops: story ? 5 : (hasImageCreation ? 6 : 5),
  };
}
