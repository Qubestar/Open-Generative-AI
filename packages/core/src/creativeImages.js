import { IMAGE_SOURCES } from './story.js';

// Only the creative pipeline implements this executor. Legacy Story/API jobs
// retain their own catalog so they cannot accidentally submit Codex as an API.
export const CREATIVE_IMAGE_SOURCES = [IMAGE_SOURCES[0], {
  id:'codex-images', name:'Codex Images · ChatGPT plan', provider:null,
  manual:false, subscription:true,
  note:'Uses your signed-in Codex CLI and GPT Image 2. No image API key or Flow extension. Counts toward Codex usage limits; not unlimited. Google Flow remains available if access or allowance runs out.',
  models:[{id:'gpt-image-2',label:'GPT Image 2 · native Codex'}],
}, ...IMAGE_SOURCES.slice(1)];
export function getCreativeImageSource(id) {
  return CREATIVE_IMAGE_SOURCES.find(source => source.id === id) || CREATIVE_IMAGE_SOURCES[0];
}
export function resolveCreativeImageModel(id, model) {
  const source=getCreativeImageSource(id);
  return source.models.find(item=>item.id===model)?.id || source.models[0]?.id || null;
}
