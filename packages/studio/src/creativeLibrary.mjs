// Small local labels and job relationships only: never media or credentials.
export const CREATIVE_LIBRARY_KEY = 'vidmyo.creative-library.v1';
const LIMIT = 128;
const id = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value) ? value : '';
export const collectionName = value => typeof value === 'string' ? value.trim().slice(0, 80) : '';
const key = (kind, jobId) => ['image', 'video'].includes(kind) && id(jobId) ? `${kind}:${jobId}` : '';
function clean(record) {
  return { collection: collectionName(record?.collection), favorite: record?.favorite === true,
    sourceImageJobId: id(record?.sourceImageJobId) };
}
export function loadCreativeLibrary(storage) {
  try {
    const data = JSON.parse(storage?.getItem?.(CREATIVE_LIBRARY_KEY));
    if (data?.version !== 1 || !Array.isArray(data.entries)) return {};
    return Object.fromEntries(data.entries.slice(0, LIMIT).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && /^(image|video):[\w.-]{1,160}$/.test(entry[0])).map(([k,v]) => [k, clean(v)]));
  } catch { return {}; }
}
export function jobMetadata(library, kind, jobId) { return clean(library?.[key(kind,jobId)]); }
export function saveJobMetadata(storage, library, kind, jobId, patch) {
  const k = key(kind, jobId);
  if (!k) return { library, persisted: false };
  const next = Object.fromEntries([[k,clean({ ...library?.[k], ...patch })], ...Object.entries(library || {}).filter(([old]) => old !== k && /^(image|video):[\w.-]{1,160}$/.test(old)).map(([old,v])=>[old,clean(v)])].slice(0,LIMIT));
  try { storage.setItem(CREATIVE_LIBRARY_KEY, JSON.stringify({version:1,entries:Object.entries(next)})); return {library:next,persisted:true}; }
  catch { return {library:next,persisted:false}; }
}
export function matchesLibraryFilter(library, kind, jobId, filter) {
  const metadata = jobMetadata(library,kind,jobId);
  if (filter === 'favorites') return metadata.favorite;
  if (filter === 'unfiled') return !metadata.collection;
  return !filter || filter === 'all' || (filter.startsWith('collection:') && metadata.collection === filter.slice(11));
}
