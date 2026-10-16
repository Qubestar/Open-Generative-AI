export const CREATIVE_HISTORY_STORAGE_KEY = 'vidmyo.creative-settings.v1';
export const CREATIVE_HISTORY_LIMIT = 24;

const TEXT_LIMIT = 12_000;

function text(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : fallback;
}

function settingsObject(details) {
  return details && typeof details === 'object' && !Array.isArray(details) ? details : {};
}

function sanitizeImage(details) {
  details = settingsObject(details);
  return {
    prompt: text(details.prompt),
    model: text(details.model),
    endpoint: text(details.endpoint),
    customModel: text(details.customModel),
    aspect: text(details.aspect, 'square'),
    provider: text(details.provider),
    modelLabel: text(details.modelLabel),
  };
}

function sanitizeVideo(details) {
  details = settingsObject(details);
  return {
    animate: Boolean(details.animate),
    prompt: text(details.prompt),
    model: text(details.model),
    customModel: text(details.customModel),
    aspect: text(details.aspect, '16:9'),
    duration: text(details.duration, 'auto'),
    // Deliberately retain no data URL or file path. The source must be chosen
    // again after restart so history stays small and contains settings only.
    requiresSourceImage: Boolean(details.animate),
  };
}

export function sanitizeGenerationSettings(kind, details) {
  return kind === 'video' ? sanitizeVideo(details) : sanitizeImage(details);
}

function emptyHistory() {
  return { version: 1, image: [], video: [] };
}

function parseHistory(storage) {
  if (!storage?.getItem) return emptyHistory();
  try {
    const parsed = JSON.parse(storage.getItem(CREATIVE_HISTORY_STORAGE_KEY));
    if (!parsed || parsed.version !== 1) return emptyHistory();
    return {
      version: 1,
      image: Array.isArray(parsed.image) ? parsed.image : [],
      video: Array.isArray(parsed.video) ? parsed.video : [],
    };
  } catch {
    return emptyHistory();
  }
}

export function loadGenerationHistory(storage, kind) {
  const records = parseHistory(storage)[kind] || [];
  return Object.fromEntries(records
    .filter((record) => record && typeof record.jobId === 'string')
    .slice(0, CREATIVE_HISTORY_LIMIT)
    .map((record) => [record.jobId, sanitizeGenerationSettings(kind, record.settings)]));
}

export function saveGenerationSettings(storage, kind, jobId, details, limit = CREATIVE_HISTORY_LIMIT) {
  if (!storage?.setItem || typeof jobId !== 'string' || !jobId) return loadGenerationHistory(storage, kind);
  const history = parseHistory(storage);
  const record = { jobId, settings: sanitizeGenerationSettings(kind, details) };
  history[kind] = [record, ...history[kind].filter((item) => (
    item && typeof item.jobId === 'string' && item.jobId && item.jobId !== jobId
  ))].slice(0, Math.max(1, limit));
  try {
    storage.setItem(CREATIVE_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Generation succeeded even if storage is unavailable or over quota.
  }
  return Object.fromEntries(history[kind].map((item) => [item.jobId, item.settings]));
}
