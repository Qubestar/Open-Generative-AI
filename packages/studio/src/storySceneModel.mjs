export function resolveSelectedScene(scenes = [], id) {
  return scenes.find(scene => scene.id === id) || scenes[0] || null;
}

export function sceneDuration(scene) {
  const span = scene?.narrationSpan;
  if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isFinite) || span[1] < span[0]) return null;
  return span[1] - span[0];
}

export function sceneState(scene) {
  if (!scene?.image?.artifact) return 'Needs image';
  return scene.image.approved ? 'Approved' : 'Review image';
}
