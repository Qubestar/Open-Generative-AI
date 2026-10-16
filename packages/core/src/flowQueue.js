// Curio Flow Queue interchange format. This is deliberately small and pure:
// the Chrome extension owns browser automation, while Vidmyo owns the durable
// Story project and scene prompts.

const ASPECTS = new Set(['16:9', '9:16']);
const SCENE_ID = /^s\d{3,}$/;

export function flowProjectId(value) {
  const compact = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // Extension queue ids may not start with a dash and must remain useful when
  // importing from Downloads. The project id is already random and stable.
  return `vidmyo-${compact || 'project'}`.slice(0, 120).replace(/-+$/g, '');
}

export function createFlowQueue({ projectId, aspect, scenes } = {}) {
  if (!ASPECTS.has(aspect)) throw new Error('Google Flow queue needs a 16:9 or 9:16 aspect ratio.');
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('Google Flow queue needs at least one scene.');
  const ids = new Set();
  const normalized = scenes.map((scene, index) => {
    const sceneId = String(scene?.sceneId ?? scene?.id ?? '').trim();
    const prompt = String(scene?.prompt ?? '').trim();
    if (!SCENE_ID.test(sceneId)) throw new Error(`Google Flow queue scene ${index + 1} must use sNNN.`);
    if (!prompt) throw new Error(`Google Flow queue scene ${sceneId} has no prompt.`);
    if (ids.has(sceneId)) throw new Error(`Google Flow queue repeats ${sceneId}.`);
    ids.add(sceneId);
    return { sceneId, prompt, kind: 'image', expectedAspectRatio: aspect };
  });
  return {
    schemaVersion: 1,
    projectId: flowProjectId(projectId),
    outputDirectory: 'downloads',
    downloadSubdirectory: 'images',
    scenes: normalized,
  };
}
