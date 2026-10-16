// Channel Workspace contracts and local video-queue domain rules.
//
// A workspace is the durable source of truth for a channel and its videos.
// Tracker row numbers are only sync-location metadata: stable `video_*` IDs
// link queue items to local production projects even after a sheet is sorted.

import crypto from 'node:crypto';

export const CHANNEL_MANIFEST_NAME = 'channel.json';
export const CHANNEL_MANIFEST_VERSION = 1;
export const CHANNEL_ID_PREFIX = 'channel';
export const VIDEO_ID_PREFIX = 'video';

export const VIDEO_STATUSES = Object.freeze([
  'draft', 'ready', 'claimed', 'producing', 'review', 'rendered', 'scheduled', 'published',
  'blocked', 'skipped', 'archived',
]);

export const TRACKER_COLUMNS = Object.freeze([
  'Status', 'Video #', 'Working Title', 'Hook', 'Topic / Angle', 'Script', 'Voiceover',
  'Images', 'MP4 File', 'Description', 'Tags', 'Hashtags', 'Thumbnail', 'Publish Date',
  'YouTube Link', 'Notes', 'Agent', 'Claimed (UTC)', 'Drive File ID',
  'Optimized (AI label/cards)', 'Thumbnail File ID',
]);

const STATUS_TRANSITIONS = Object.freeze({
  draft: ['ready', 'blocked', 'skipped', 'archived'],
  ready: ['draft', 'blocked', 'skipped', 'archived'],
  claimed: ['ready', 'producing', 'blocked', 'skipped', 'archived'],
  producing: ['review', 'rendered', 'blocked', 'archived'],
  review: ['producing', 'rendered', 'blocked', 'archived'],
  rendered: ['review', 'scheduled', 'published', 'blocked', 'archived'],
  scheduled: ['rendered', 'published', 'blocked', 'archived'],
  published: ['archived'],
  blocked: ['draft', 'ready', 'skipped', 'archived'],
  skipped: ['draft', 'ready', 'archived'],
  archived: ['draft'],
});

const TRACKER_KEYS = Object.freeze([
  'status', 'videoNumber', 'workingTitle', 'hook', 'topicAngle', 'script', 'voiceover',
  'images', 'mp4File', 'description', 'tags', 'hashtags', 'thumbnail', 'publishDate',
  'youtubeLink', 'notes', 'agent', 'claimedUtc', 'driveFileId', 'optimized', 'thumbnailFileId',
]);

const SAFE_ID_RE = /^[a-z][a-z0-9]*_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const STATUS_LABELS = Object.freeze({
  draft: 'Draft', ready: 'Ready', claimed: 'Claimed', producing: 'In Production',
  review: 'Review', rendered: 'Rendered', scheduled: 'Scheduled', published: 'Published',
  blocked: 'Blocked', skipped: 'Skipped', archived: 'Archived',
});
const LABEL_STATUSES = Object.freeze({
  draft: 'draft', planned: 'draft', ready: 'ready', claimed: 'claimed',
  'in production': 'producing', producing: 'producing', review: 'review', rendered: 'rendered',
  scheduled: 'scheduled', published: 'published', blocked: 'blocked', skipped: 'skipped',
  archived: 'archived',
});

function fail(pathName, message) {
  throw new Error(`${pathName}: ${message}`);
}

function clone(value) {
  return structuredClone(value);
}

function asObject(value, pathName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(pathName, 'must be an object');
  return value;
}

function optionalString(value, pathName, { max = 10000 } = {}) {
  if (value !== null && value !== undefined && (typeof value !== 'string' || value.length > max)) {
    fail(pathName, `must be a string up to ${max} characters or null`);
  }
}

function nonEmptyString(value, pathName, { max = 10000 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(pathName, `must be a non-empty string up to ${max} characters`);
  }
}

function isoDate(value, pathName) {
  nonEmptyString(value, pathName, { max: 40 });
  if (!ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(value))) fail(pathName, 'must be an ISO-8601 UTC date-time');
}

function nowIso(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('clock: must return a valid date');
  return date.toISOString();
}

function generatedId(prefix, idGenerator) {
  const id = idGenerator ? idGenerator(prefix) : `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
  assertStableId(id, prefix, 'id');
  return id;
}

function defaultChannelFields(input = {}) {
  return {
    name: input.name ?? 'Untitled channel',
    youtube: {
      channelId: null, url: null, lastRefreshedAt: null,
      ...(input.youtube || {}),
    },
    strategy: {
      language: null, audience: null, positioning: null, pillars: [], cadence: null,
      ...(input.strategy || {}),
    },
    defaults: {
      kind: 'story', style: null, aspect: '16:9', durationSec: null,
      ...(input.defaults || {}),
    },
    tracker: {
      sheetId: null, tab: 'Videos', syncMode: 'local-only',
      ...(input.tracker || {}),
    },
    research: normalizeResearch(input.research),
    analysis: input.analysis && typeof input.analysis === 'object' && !Array.isArray(input.analysis)
      ? clone(input.analysis) : null,
  };
}

function normalizeResearch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = ['existing', 'examples', 'niche'].includes(value.mode) ? value.mode : 'niche';
  return {
    mode,
    profileUrl: typeof value.profileUrl === 'string' ? value.profileUrl.slice(0, 2048) : '',
    exampleUrls: Array.isArray(value.exampleUrls) ? value.exampleUrls.filter(item => typeof item === 'string').slice(0, 3).map(item => item.slice(0, 2048)) : [],
    niche: typeof value.niche === 'string' ? value.niche.slice(0, 1000) : '',
    goals: typeof value.goals === 'string' ? value.goals.slice(0, 2000) : '',
  };
}

function defaultTrackerFields(input = {}) {
  const result = Object.fromEntries(TRACKER_KEYS.map(key => [key, '']));
  for (const key of TRACKER_KEYS) {
    if (Object.hasOwn(input, key)) result[key] = String(input[key] ?? '');
  }
  return result;
}

function statusFromTracker(value) {
  return LABEL_STATUSES[String(value || '').trim().toLowerCase()] || 'draft';
}

function trackerStatus(status) {
  return STATUS_LABELS[status] || 'Draft';
}

export function assertStableId(id, prefix = null, pathName = 'id') {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) fail(pathName, 'must be a filesystem-safe stable ID');
  if (prefix && !id.startsWith(`${prefix}_`)) fail(pathName, `must start with ${prefix}_`);
  return id;
}

export function validateClaim(claim, pathName = 'video.claim') {
  if (claim === null) return claim;
  asObject(claim, pathName);
  const keys = ['userId', 'deviceId', 'claimedAt', 'expiresAt'];
  for (const key of keys) if (!Object.hasOwn(claim, key)) fail(`${pathName}.${key}`, 'is required');
  for (const key of Object.keys(claim)) if (!keys.includes(key)) fail(`${pathName}.${key}`, 'is not allowed');
  nonEmptyString(claim.userId, `${pathName}.userId`, { max: 128 });
  nonEmptyString(claim.deviceId, `${pathName}.deviceId`, { max: 128 });
  isoDate(claim.claimedAt, `${pathName}.claimedAt`);
  isoDate(claim.expiresAt, `${pathName}.expiresAt`);
  if (Date.parse(claim.expiresAt) <= Date.parse(claim.claimedAt)) fail(`${pathName}.expiresAt`, 'must be after claimedAt');
  return claim;
}

export function validateVideoItem(video, pathName = 'video') {
  asObject(video, pathName);
  const required = [
    'id', 'sequence', 'title', 'hook', 'angle', 'pillar', 'kind', 'style', 'priority', 'status',
    'claim', 'productionProjectId', 'sheet', 'trackerFields', 'createdAt', 'updatedAt',
  ];
  for (const key of required) if (!Object.hasOwn(video, key)) fail(`${pathName}.${key}`, 'is required');
  for (const key of Object.keys(video)) if (!required.includes(key)) fail(`${pathName}.${key}`, 'is not allowed');
  assertStableId(video.id, VIDEO_ID_PREFIX, `${pathName}.id`);
  if (!Number.isInteger(video.sequence) || video.sequence < 1) fail(`${pathName}.sequence`, 'must be a positive integer');
  nonEmptyString(video.title, `${pathName}.title`, { max: 500 });
  for (const key of ['hook', 'angle', 'pillar', 'kind', 'style']) optionalString(video[key], `${pathName}.${key}`, { max: 10000 });
  if (!Number.isInteger(video.priority) || video.priority < 0 || video.priority > 100) {
    fail(`${pathName}.priority`, 'must be an integer from 0 to 100');
  }
  if (!VIDEO_STATUSES.includes(video.status)) fail(`${pathName}.status`, `must be one of ${VIDEO_STATUSES.join(', ')}`);
  validateClaim(video.claim, `${pathName}.claim`);
  if (video.status === 'claimed' && video.claim === null) fail(`${pathName}.claim`, 'is required while status is claimed');
  optionalString(video.productionProjectId, `${pathName}.productionProjectId`, { max: 256 });
  asObject(video.sheet, `${pathName}.sheet`);
  const sheetKeys = ['lastKnownRow', 'revision'];
  for (const key of sheetKeys) if (!Object.hasOwn(video.sheet, key)) fail(`${pathName}.sheet.${key}`, 'is required');
  for (const key of Object.keys(video.sheet)) if (!sheetKeys.includes(key)) fail(`${pathName}.sheet.${key}`, 'is not allowed');
  if (video.sheet.lastKnownRow !== null && (!Number.isInteger(video.sheet.lastKnownRow) || video.sheet.lastKnownRow < 1)) {
    fail(`${pathName}.sheet.lastKnownRow`, 'must be a positive integer or null');
  }
  if (!Number.isInteger(video.sheet.revision) || video.sheet.revision < 0) fail(`${pathName}.sheet.revision`, 'must be a non-negative integer');
  asObject(video.trackerFields, `${pathName}.trackerFields`);
  for (const key of TRACKER_KEYS) {
    if (!Object.hasOwn(video.trackerFields, key)) fail(`${pathName}.trackerFields.${key}`, 'is required');
    optionalString(video.trackerFields[key], `${pathName}.trackerFields.${key}`);
  }
  for (const key of Object.keys(video.trackerFields)) if (!TRACKER_KEYS.includes(key)) fail(`${pathName}.trackerFields.${key}`, 'is not allowed');
  isoDate(video.createdAt, `${pathName}.createdAt`);
  isoDate(video.updatedAt, `${pathName}.updatedAt`);
  return video;
}

export function validateChannelManifest(manifest) {
  asObject(manifest, 'manifest');
  const required = ['version', 'id', 'name', 'youtube', 'strategy', 'defaults', 'tracker', 'research', 'analysis', 'videos', 'createdAt', 'updatedAt'];
  for (const key of required) if (!Object.hasOwn(manifest, key)) fail(`manifest.${key}`, 'is required');
  for (const key of Object.keys(manifest)) if (!required.includes(key)) fail(`manifest.${key}`, 'is not allowed');
  if (manifest.version !== CHANNEL_MANIFEST_VERSION) fail('manifest.version', `expected ${CHANNEL_MANIFEST_VERSION}`);
  assertStableId(manifest.id, CHANNEL_ID_PREFIX, 'manifest.id');
  nonEmptyString(manifest.name, 'manifest.name', { max: 500 });
  for (const section of ['youtube', 'strategy', 'defaults', 'tracker']) asObject(manifest[section], `manifest.${section}`);
  optionalString(manifest.youtube.channelId, 'manifest.youtube.channelId', { max: 256 });
  optionalString(manifest.youtube.url, 'manifest.youtube.url', { max: 2048 });
  if (manifest.youtube.lastRefreshedAt !== null) isoDate(manifest.youtube.lastRefreshedAt, 'manifest.youtube.lastRefreshedAt');
  for (const key of ['language', 'audience', 'positioning', 'cadence']) optionalString(manifest.strategy[key], `manifest.strategy.${key}`);
  if (!Array.isArray(manifest.strategy.pillars) || manifest.strategy.pillars.some(value => typeof value !== 'string' || value.length > 500)) {
    fail('manifest.strategy.pillars', 'must be an array of strings up to 500 characters');
  }
  for (const key of ['kind', 'style', 'aspect']) optionalString(manifest.defaults[key], `manifest.defaults.${key}`, { max: 500 });
  if (manifest.defaults.durationSec !== null && (!Number.isInteger(manifest.defaults.durationSec) || manifest.defaults.durationSec < 1)) {
    fail('manifest.defaults.durationSec', 'must be a positive integer or null');
  }
  for (const key of ['sheetId', 'tab', 'syncMode']) optionalString(manifest.tracker[key], `manifest.tracker.${key}`, { max: 500 });
  if (manifest.research !== null) {
    const normalized = normalizeResearch(manifest.research);
    if (JSON.stringify(normalized) !== JSON.stringify(manifest.research)) fail('manifest.research', 'contains invalid or unbounded fields');
  }
  if (manifest.analysis !== null) {
    asObject(manifest.analysis, 'manifest.analysis');
    let encoded;
    try { encoded = JSON.stringify(manifest.analysis); } catch { fail('manifest.analysis', 'must be JSON serializable'); }
    if (encoded.length > 500000) fail('manifest.analysis', 'must be at most 500000 characters');
  }
  if (!Array.isArray(manifest.videos)) fail('manifest.videos', 'must be an array');
  const ids = new Set();
  const sequences = new Set();
  manifest.videos.forEach((video, index) => {
    validateVideoItem(video, `manifest.videos.${index}`);
    if (ids.has(video.id)) fail(`manifest.videos.${index}.id`, 'must be unique');
    if (sequences.has(video.sequence)) fail(`manifest.videos.${index}.sequence`, 'must be unique');
    ids.add(video.id); sequences.add(video.sequence);
  });
  isoDate(manifest.createdAt, 'manifest.createdAt');
  isoDate(manifest.updatedAt, 'manifest.updatedAt');
  return manifest;
}

export function createChannelManifest(input = {}, { clock, idGenerator } = {}) {
  const now = nowIso(clock);
  const fields = defaultChannelFields(input);
  const manifest = {
    version: CHANNEL_MANIFEST_VERSION,
    id: input.id || generatedId(CHANNEL_ID_PREFIX, idGenerator),
    ...fields,
    videos: [],
    createdAt: now,
    updatedAt: now,
  };
  validateChannelManifest(manifest);
  return manifest;
}

export function listVideos(manifest) {
  validateChannelManifest(manifest);
  return clone(manifest.videos);
}

export function getVideo(manifest, videoId) {
  validateChannelManifest(manifest);
  assertStableId(videoId, VIDEO_ID_PREFIX, 'videoId');
  const video = manifest.videos.find(item => item.id === videoId);
  if (!video) throw new Error(`No video ${videoId}`);
  return clone(video);
}

function withVideo(manifest, videoId, change, { clock } = {}) {
  validateChannelManifest(manifest);
  assertStableId(videoId, VIDEO_ID_PREFIX, 'videoId');
  const next = clone(manifest);
  const index = next.videos.findIndex(item => item.id === videoId);
  if (index < 0) throw new Error(`No video ${videoId}`);
  const changed = change(next.videos[index]);
  next.videos[index] = changed;
  next.updatedAt = nowIso(clock);
  validateChannelManifest(next);
  return next;
}

export function addVideo(manifest, input = {}, { clock, idGenerator } = {}) {
  validateChannelManifest(manifest);
  const next = clone(manifest);
  const now = nowIso(clock);
  const sequence = input.sequence ?? Math.max(0, ...next.videos.map(video => video.sequence)) + 1;
  const video = {
    id: input.id || generatedId(VIDEO_ID_PREFIX, idGenerator),
    sequence,
    title: input.title ?? 'Untitled video',
    hook: input.hook ?? '',
    angle: input.angle ?? '',
    pillar: input.pillar ?? '',
    kind: input.kind ?? next.defaults.kind ?? 'story',
    style: input.style ?? next.defaults.style ?? '',
    priority: input.priority ?? 50,
    status: input.status ?? 'draft',
    claim: null,
    productionProjectId: null,
    sheet: { lastKnownRow: null, revision: 0, ...(input.sheet || {}) },
    trackerFields: defaultTrackerFields(input.trackerFields),
    createdAt: now,
    updatedAt: now,
  };
  if (input.claim !== undefined) video.claim = clone(input.claim);
  if (input.productionProjectId !== undefined) video.productionProjectId = input.productionProjectId;
  next.videos.push(video);
  next.updatedAt = now;
  validateChannelManifest(next);
  return next;
}

const MUTABLE_VIDEO_FIELDS = new Set(['sequence', 'title', 'hook', 'angle', 'pillar', 'kind', 'style', 'priority', 'sheet', 'trackerFields']);

export function updateVideo(manifest, videoId, patch = {}, { clock } = {}) {
  asObject(patch, 'patch');
  for (const key of Object.keys(patch)) if (!MUTABLE_VIDEO_FIELDS.has(key)) fail(`patch.${key}`, 'must use a dedicated queue operation');
  return withVideo(manifest, videoId, video => ({
    ...video,
    ...clone(patch),
    sheet: patch.sheet ? { ...video.sheet, ...clone(patch.sheet) } : video.sheet,
    trackerFields: patch.trackerFields ? { ...video.trackerFields, ...clone(patch.trackerFields) } : video.trackerFields,
    updatedAt: nowIso(clock),
  }), { clock });
}

export function canTransitionVideo(from, to) {
  return VIDEO_STATUSES.includes(from) && VIDEO_STATUSES.includes(to) && STATUS_TRANSITIONS[from].includes(to);
}

export function transitionVideo(manifest, videoId, status, { clock } = {}) {
  if (!VIDEO_STATUSES.includes(status)) fail('status', `must be one of ${VIDEO_STATUSES.join(', ')}`);
  if (status === 'claimed') throw new Error('Use claimVideo to enter claimed status');
  return withVideo(manifest, videoId, video => {
    if (!canTransitionVideo(video.status, status)) throw new Error(`Illegal video status transition ${video.status} → ${status}`);
    return { ...video, status, claim: status === 'ready' ? null : video.claim, updatedAt: nowIso(clock) };
  }, { clock });
}

export function archiveVideo(manifest, videoId, options = {}) {
  return transitionVideo(manifest, videoId, 'archived', options);
}

export function nextReady(manifest) {
  validateChannelManifest(manifest);
  const candidates = manifest.videos.filter(video => video.status === 'ready');
  candidates.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence || left.id.localeCompare(right.id));
  return candidates.length ? clone(candidates[0]) : null;
}

export function claimVideo(manifest, videoId, { userId, deviceId, leaseMs = 30 * 60 * 1000, clock } = {}) {
  nonEmptyString(userId, 'claim.userId', { max: 128 });
  nonEmptyString(deviceId, 'claim.deviceId', { max: 128 });
  if (!Number.isInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 24 * 60 * 60 * 1000) {
    fail('claim.leaseMs', 'must be an integer from 60000 to 86400000');
  }
  const claimedAt = nowIso(clock);
  const expiresAt = new Date(Date.parse(claimedAt) + leaseMs).toISOString();
  return withVideo(manifest, videoId, video => {
    if (video.status !== 'ready') throw new Error(`Video ${video.id} is ${video.status}; only ready videos can be claimed`);
    return { ...video, status: 'claimed', claim: { userId, deviceId, claimedAt, expiresAt }, updatedAt: claimedAt };
  }, { clock });
}

export function releaseClaim(manifest, videoId, { userId, deviceId, clock } = {}) {
  return withVideo(manifest, videoId, video => {
    if (video.status !== 'claimed' || !video.claim) throw new Error(`Video ${video.id} has no releasable claim`);
    if (userId !== undefined && userId !== video.claim.userId) throw new Error('Only the claiming user can release this claim');
    if (deviceId !== undefined && deviceId !== video.claim.deviceId) throw new Error('Only the claiming device can release this claim');
    return { ...video, status: 'ready', claim: null, updatedAt: nowIso(clock) };
  }, { clock });
}

export function recoverStaleClaims(manifest, { clock } = {}) {
  validateChannelManifest(manifest);
  const now = Date.parse(nowIso(clock));
  const next = clone(manifest);
  const recoveredIds = [];
  next.videos = next.videos.map(video => {
    if (video.status !== 'claimed' || !video.claim || Date.parse(video.claim.expiresAt) > now) return video;
    recoveredIds.push(video.id);
    return { ...video, status: 'ready', claim: null, updatedAt: new Date(now).toISOString() };
  });
  if (recoveredIds.length) next.updatedAt = new Date(now).toISOString();
  validateChannelManifest(next);
  return { manifest: next, recoveredIds };
}

export function linkProduction(manifest, videoId, productionProjectId, { clock } = {}) {
  nonEmptyString(productionProjectId, 'productionProjectId', { max: 256 });
  if (!SAFE_ID_RE.test(productionProjectId)) fail('productionProjectId', 'must be a filesystem-safe stable ID');
  return withVideo(manifest, videoId, video => {
    if (!['claimed', 'producing'].includes(video.status)) {
      throw new Error(`Video ${video.id} is ${video.status}; claim it before linking production`);
    }
    return { ...video, productionProjectId, status: 'producing', updatedAt: nowIso(clock) };
  }, { clock });
}

export function importTrackerRows(manifest, rows, { metadata = [], clock, idGenerator } = {}) {
  validateChannelManifest(manifest);
  if (!Array.isArray(rows)) fail('rows', 'must be an array');
  if (!Array.isArray(metadata)) fail('metadata', 'must be an array');
  const metadataByRow = new Map();
  for (const [index, entry] of metadata.entries()) {
    asObject(entry, `metadata.${index}`);
    assertStableId(entry.videoId, VIDEO_ID_PREFIX, `metadata.${index}.videoId`);
    if (!Number.isInteger(entry.row) || entry.row < 1) fail(`metadata.${index}.row`, 'must be a positive integer');
    if (metadataByRow.has(entry.row)) fail(`metadata.${index}.row`, 'must be unique');
    metadataByRow.set(entry.row, entry);
  }
  const first = rows[0];
  const dataRows = Array.isArray(first) && first.length === TRACKER_COLUMNS.length
    && String(first[2] || '').trim().toLowerCase() === 'working title' ? rows.slice(1) : rows;
  const next = clone(manifest);
  const existingById = new Map(next.videos.map(video => [video.id, video]));
  const importedIds = [];
  const createdIds = [];
  const now = nowIso(clock);
  dataRows.forEach((entry, index) => {
    const row = Array.isArray(entry) ? index + (dataRows === rows ? 1 : 2) : entry.row;
    const values = Array.isArray(entry) ? entry : (entry.values || entry.cells);
    if (!Array.isArray(values) || values.length !== TRACKER_COLUMNS.length) fail(`rows.${index}`, 'must contain exactly 21 tracker columns');
    const fields = defaultTrackerFields(Object.fromEntries(TRACKER_KEYS.map((key, fieldIndex) => [key, values[fieldIndex]])));
    if (!fields.workingTitle.trim()) return;
    const mapped = metadataByRow.get(row);
    const importedStatus = statusFromTracker(fields.status);
    const importedClaim = importedStatus === 'claimed' ? {
      userId: fields.agent.trim() || 'tracker-import',
      deviceId: 'tracker-import',
      claimedAt: ISO_DATE_RE.test(fields.claimedUtc) && !Number.isNaN(Date.parse(fields.claimedUtc)) ? fields.claimedUtc : now,
      expiresAt: new Date(Date.parse(
        ISO_DATE_RE.test(fields.claimedUtc) && !Number.isNaN(Date.parse(fields.claimedUtc)) ? fields.claimedUtc : now,
      ) + 60_000).toISOString(),
    } : null;
    let video = mapped ? existingById.get(mapped.videoId) : null;
    if (!video) {
      const id = mapped?.videoId || generatedId(VIDEO_ID_PREFIX, idGenerator);
      if (existingById.has(id)) fail(`rows.${index}`, `metadata points to duplicate video ${id}`);
      video = {
        id,
        sequence: Math.max(0, ...next.videos.map(item => item.sequence)) + 1,
        title: fields.workingTitle,
        hook: fields.hook,
        angle: fields.topicAngle,
        pillar: '', kind: next.defaults.kind ?? 'story', style: next.defaults.style ?? '', priority: 50,
        status: importedStatus, claim: importedClaim, productionProjectId: null,
        sheet: { lastKnownRow: row, revision: mapped?.revision ?? 0 }, trackerFields: fields,
        createdAt: now, updatedAt: now,
      };
      next.videos.push(video);
      existingById.set(id, video);
      createdIds.push(id);
    } else {
      video.title = fields.workingTitle;
      video.hook = fields.hook;
      video.angle = fields.topicAngle;
      video.status = importedStatus;
      video.sheet = { lastKnownRow: row, revision: Math.max(video.sheet.revision + 1, mapped?.revision ?? 0) };
      video.trackerFields = fields;
      video.claim = importedClaim;
      video.updatedAt = now;
    }
    importedIds.push(video.id);
  });
  next.updatedAt = now;
  validateChannelManifest(next);
  return { manifest: next, importedIds, createdIds };
}

export function exportTrackerRows(manifest, { includeHeader = true } = {}) {
  validateChannelManifest(manifest);
  const rows = manifest.videos
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map(video => {
      const fields = { ...video.trackerFields };
      fields.status = trackerStatus(video.status);
      fields.videoNumber = fields.videoNumber || String(video.sequence);
      fields.workingTitle = video.title;
      fields.hook = video.hook || '';
      fields.topicAngle = video.angle || '';
      fields.claimedUtc = video.claim?.claimedAt || '';
      return TRACKER_KEYS.map(key => fields[key] ?? '');
    });
  return includeHeader ? [Array.from(TRACKER_COLUMNS), ...rows] : rows;
}

export function trackerRowMetadata(manifest, { headerRows = 1 } = {}) {
  validateChannelManifest(manifest);
  if (!Number.isInteger(headerRows) || headerRows < 0) fail('headerRows', 'must be a non-negative integer');
  return manifest.videos
    .slice()
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((video, index) => ({ videoId: video.id, row: headerRows + index + 1, revision: video.sheet.revision }));
}
