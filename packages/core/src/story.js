// Story engine — style templates and the pure orchestration logic of
// Story Studio. Execution (spawning the vendored Python pipeline, provider
// calls) is layered on top via JobStore/runJob; everything here is pure and
// testable: prompt composition, beat→scene import, script validation, and
// stage derivation.
//
import { GENERATION_SOURCES } from './generation.js';

// Style template #1 is the production-proven faceless doodle look
// (pipelines/doodle/references/style-spec.md). New styles are data, not code.

export const STORY_STAGES = [
  'script', 'voiceover', 'beats', 'prompts', 'images', 'assemble', 'finalize',
];

export const DOODLE_STYLE = {
  id: 'doodle-v1',
  name: 'Faceless doodle (whiteboard explainer)',
  aspect: '16:9',
  // Authoritative prompt format: anchor + [SCENE] + lock, verbatim from the
  // style spec. Changing these strings changes the channel's look — don't.
  promptAnchor: 'Hand-drawn 2D doodle cartoon animation, flat colors, bold black outlines, slightly imperfect sketchy marker lines,',
  promptLock: 'no gradients, no shadows, no textures, no photorealism, no 3D, 16:9 aspect ratio, educational YouTube explainer doodle style.',
  palette: {
    orange: '#F5820D', cobalt: '#2D5FBF', green: '#3A9E3A', yellow: '#F5C518',
    red: '#D94040', brown: '#8B5E3C', sky: '#6EB5E8', tan: '#C4965A', white: '#FFFFFF',
  },
  voice: 'am_onyx',           // Kokoro: deep calm documentary narrator (approved default)
  // Retention hard rule: finished video must be over 5 minutes (target 8-9).
  // ~150-170 wpm after pauses → 1,400-1,900 words of clean narration.
  minWords: 1400,
  maxWords: 1900,
  minDurationSec: 300,
  imageSourceDefault: 'flow', // Google Flow · Nano Banana 2 (free) — Luke's quality bar
};

export const STYLES = { [DOODLE_STYLE.id]: DOODLE_STYLE };

export function getStyle(id) {
  const style = STYLES[id];
  if (!style) throw new Error(`Unknown story style "${id}" (have: ${Object.keys(STYLES).join(', ')})`);
  return style;
}

// Where scene images come from. `flow` is the default and the quality bar:
// free, but manual — you generate in Google Flow and Attach each scene, so
// there is nothing for the app to call. The generating sources are DERIVED
// from generation.js's catalog (the single source of truth for cloud
// sources/models), so Story and the generic MCP tools can't drift apart.
export const IMAGE_SOURCES = [
  {
    id: 'flow',
    name: 'Google Flow',
    manual: true,          // no API — the app can't generate, only accept an Attach
    provider: null,
    note: 'Free · generate in Flow (incl. Nano Banana 2), then Attach each scene.',
    models: [],
  },
  ...GENERATION_SOURCES.filter((s) => s.models.image.length > 0).map((s) => ({
    id: s.id,
    name: s.name,
    manual: false,
    provider: s.provider,
    note: `Paid per image · uses your ${s.name} key.`,
    models: s.models.image,
  })),
];

// Unknown ids fall back to the default source, mirroring getProviderById's
// tolerance — a stale config must not break the Story tab.
export function getImageSource(id) {
  return IMAGE_SOURCES.find((s) => s.id === id)
    || IMAGE_SOURCES.find((s) => s.id === DOODLE_STYLE.imageSourceDefault)
    || IMAGE_SOURCES[0];
}

// The model to use for a source: the caller's choice if that source actually
// offers it, else that source's first model (switching source must not carry a
// stale model id across — "fal-ai/flux/dev" is meaningless to Agnes).
export function resolveImageModel(sourceId, modelId) {
  const source = getImageSource(sourceId);
  const known = source.models.some((m) => m.id === modelId);
  return known ? modelId : (source.models[0]?.id || null);
}

// Compose the full image prompt for a scene: anchor + scene + lock.
export function buildImagePrompt(sceneText, style = DOODLE_STYLE) {
  const scene = String(sceneText || '').trim();
  if (!scene) throw new Error('buildImagePrompt: scene description is empty');
  return `${style.promptAnchor} ${scene.replace(/[.\s]+$/, '')}, ${style.promptLock}`;
}

// Script length gate (the "video 1 shipped at 3:40" lesson): enforce the
// word-count proxy BEFORE spending time on voiceover and images.
export function validateScript(text, style = DOODLE_STYLE) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return {
    words,
    ok: words >= style.minWords,
    minWords: style.minWords,
    maxWords: style.maxWords,
    hint: words < style.minWords
      ? `Script is ${words} words — under the ${style.minWords}-word floor (video would run short of 5:00). Expand every Setup-Tension-Payoff loop before generating the voiceover.`
      : null,
  };
}

// Import detect_beats.py output into a Project: one scene per beat, in beat
// order, narrationSpan from the beat cues. The pipeline and core share the
// sNNN discipline, and this asserts they never drift.
export function importBeats(project, beatsDoc) {
  const beats = beatsDoc?.beats;
  if (!Array.isArray(beats) || beats.length === 0) {
    throw new Error('importBeats: beats.json has no beats');
  }
  if (project.manifest.scenes.length > 0) {
    throw new Error('importBeats: project already has scenes — re-import requires a fresh project');
  }
  for (const beat of beats) {
    const scene = project.addScene({ beat: beat.text || '' });
    if (scene.id !== beat.id) {
      throw new Error(`Beat/scene id drift: pipeline says ${beat.id}, project assigned ${scene.id}`);
    }
    project.updateScene(scene.id, {
      narrationSpan: [beat.start, beat.end],
      ...(beat.image_prompt ? { prompt: beat.image_prompt } : {}),
    });
  }
  if (beatsDoc.audio) {
    project.manifest.voiceover.artifact = beatsDoc.audio;
    project.save();
  }
  return project.manifest.scenes;
}

// Fill empty scene prompts from their beat text using the style template.
// Scenes with a hand-written prompt are left alone.
export function scaffoldPrompts(project, style = getStyle(project.manifest.style)) {
  const filled = [];
  for (const scene of project.manifest.scenes) {
    if (scene.prompt) continue;
    if (!scene.beat) continue;
    project.updateScene(scene.id, { prompt: buildImagePrompt(scene.beat, style) });
    filled.push(scene.id);
  }
  return filled;
}

// Derive where a project stands in the pipeline. Pure read — the UI, CLI,
// and MCP all report progress from this one function.
export function stageStatus(project) {
  const m = project.manifest;
  const scenes = m.scenes;
  const status = {
    script: !!m.script,
    voiceover: !!m.voiceover.artifact,
    beats: scenes.length > 0,
    prompts: scenes.length > 0 && scenes.every(s => !!s.prompt),
    images: scenes.length > 0 && scenes.every(s => s.image.artifact && s.image.approved),
    assemble: m.renders.length > 0,
    finalize: m.renders.some(r => r.finalized),
  };
  status.nextStage = STORY_STAGES.find(s => !status[s]) || null;
  return status;
}
