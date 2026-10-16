export const CHANNEL_STATUSES = Object.freeze([
  'ready', 'claimed', 'producing', 'review', 'blocked', 'skipped',
  'rendered', 'scheduled', 'published', 'archived',
]);

export const CHANNEL_QUEUE_GROUPS = Object.freeze([
  Object.freeze({ id: 'ready', label: 'Ready', statuses: ['ready'] }),
  Object.freeze({ id: 'production', label: 'In production', statuses: ['claimed', 'producing', 'review'] }),
  Object.freeze({ id: 'attention', label: 'Needs attention', statuses: ['draft', 'blocked', 'skipped'] }),
  Object.freeze({ id: 'rendered', label: 'Rendered', statuses: ['rendered'] }),
  Object.freeze({ id: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] }),
  Object.freeze({ id: 'published', label: 'Published', statuses: ['published'] }),
  Object.freeze({ id: 'archived', label: 'Archived', statuses: ['archived'] }),
]);

const DEFAULTS = Object.freeze({
  language: 'English',
  audience: '',
  positioning: '',
  kind: 'story',
  style: 'doodle-v1',
  aspect: '16:9',
  durationSec: 300,
});

export const CHANNEL_CREATION_MODES = Object.freeze([
  Object.freeze({ id: 'existing', label: 'Existing YouTube channel' }),
  Object.freeze({ id: 'examples', label: 'Model example channels' }),
  Object.freeze({ id: 'niche', label: 'Start from a niche' }),
]);

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function boundedIdentifier(value, fallback = '') {
  return text(value).trim().replace(/[^a-zA-Z0-9._:/-]/g, '').slice(0, 80) || fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function channelDraft(value = {}) {
  const defaults = value.defaults || {};
  const strategy = value.strategy || {};
  return {
    name: text(value.name),
    language: text(value.language, text(strategy.language, DEFAULTS.language)),
    audience: text(value.audience, text(strategy.audience)),
    positioning: text(value.positioning, text(strategy.positioning)),
    kind: text(value.kind, text(defaults.kind, DEFAULTS.kind)) === 'animation' ? 'animation' : 'story',
    style: text(value.style, text(defaults.style, DEFAULTS.style)),
    aspect: ['16:9', '9:16'].includes(text(value.aspect, text(defaults.aspect, DEFAULTS.aspect)))
      ? text(value.aspect, text(defaults.aspect, DEFAULTS.aspect)) : DEFAULTS.aspect,
    durationSec: positiveNumber(value.durationSec ?? defaults.durationSec, DEFAULTS.durationSec),
    sourceMode: text(value.sourceMode, 'niche'),
    profileUrl: text(value.profileUrl),
    exampleUrls: Array.isArray(value.exampleUrls) ? value.exampleUrls.slice(0, 3).map(item => text(item)) : ['', ''],
    niche: text(value.niche),
    goals: text(value.goals),
  };
}

export function channelInputFromDraft(value = {}) {
  const draft = channelDraft(value);
  const input = {
    name: draft.name.trim(),
    strategy: {
      language: draft.language.trim() || DEFAULTS.language,
      audience: draft.audience.trim(),
      positioning: draft.positioning.trim(),
    },
    defaults: {
      kind: draft.kind,
      style: draft.style.trim() || (draft.kind === 'story' ? 'doodle-v1' : 'editorial-collage'),
      aspect: draft.aspect,
      durationSec: positiveNumber(draft.durationSec, DEFAULTS.durationSec),
    },
  };
  const mode = text(value.sourceMode);
  const examples = Array.isArray(value.exampleUrls)
    ? value.exampleUrls.map(item => text(item).trim()).filter(Boolean).slice(0, 3) : [];
  if (['existing', 'examples', 'niche'].includes(mode)) {
    input.research = {
      mode,
      profileUrl: mode === 'existing' ? text(value.profileUrl).trim() : '',
      exampleUrls: mode === 'examples' ? examples : [],
      niche: mode === 'niche' ? text(value.niche).trim() : '',
      goals: text(value.goals).trim(),
    };
  }
  return input;
}

export function researchInputFromDraft(value = {}) {
  const input = channelInputFromDraft(value);
  return input.research || { mode: 'niche', profileUrl: '', exampleUrls: [], niche: '', goals: '' };
}

export function plannerInputFromDraft(value = {}) {
  const count = Number(value.count);
  return {
    count: count === 20 ? 20 : 10,
    goals: text(value.goals).trim(),
    niche: text(value.niche).trim(),
    referenceUrls: Array.isArray(value.referenceUrls)
      ? value.referenceUrls.map(item => text(item).trim()).filter(Boolean).slice(0, 3) : [],
    agentId: boundedIdentifier(value.agentId),
    provider: boundedIdentifier(value.provider, 'agent'),
    model: boundedIdentifier(value.model),
  };
}

export function normalizeAnalysis(value = {}) {
  const analysis = value.analysis || value.profile || value;
  return {
    profile: analysis.profile || analysis.publicProfile || {},
    evidence: Array.isArray(analysis.evidence) ? analysis.evidence : [],
    opportunities: Array.isArray(analysis.opportunities)
      ? analysis.opportunities : Array.isArray(analysis.opportunity) ? analysis.opportunity : [],
    sourceUrls: Array.isArray(analysis.sourceUrls) ? analysis.sourceUrls : [],
  };
}

export function normalizePlanItems(value = {}) {
  const items = value.items || value.plan || value.videos || [];
  return Array.isArray(items) ? items.map((item, index) => ({
    ...item,
    id: text(item?.id, `planned-${index + 1}`),
    title: text(item?.title, `Video idea ${index + 1}`),
    hook: text(item?.hook),
    angle: text(item?.angle),
    pillar: text(item?.pillar),
    priority: positiveNumber(item?.priority, 50),
    selected: item?.selected !== false,
  })) : [];
}

export function normalizeVideo(value = {}) {
  const status = text(value.status, 'ready').toLowerCase();
  return {
    ...value,
    id: text(value.id),
    sequence: positiveNumber(value.sequence, 0),
    title: text(value.title, 'Untitled idea'),
    hook: text(value.hook),
    angle: text(value.angle),
    pillar: text(value.pillar),
    kind: text(value.kind, 'story') === 'animation' ? 'animation' : 'story',
    style: text(value.style),
    priority: positiveNumber(value.priority, 0),
    status: CHANNEL_STATUSES.includes(status) ? status : 'ready',
    claim: value.claim || null,
  };
}

export function channelVideos(manifest = {}) {
  return Array.isArray(manifest.videos)
    ? manifest.videos.map(normalizeVideo).sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority;
      if (left.sequence && right.sequence) return left.sequence - right.sequence;
      return left.title.localeCompare(right.title);
    })
    : [];
}

export function groupedChannelVideos(manifest = {}) {
  const videos = channelVideos(manifest);
  return CHANNEL_QUEUE_GROUPS.map(group => ({
    ...group,
    videos: videos.filter(video => group.statuses.includes(video.status)),
  }));
}

export function readyChannelVideos(manifest = {}) {
  return channelVideos(manifest).filter(video => video.status === 'ready');
}

export function nextReadyChannelVideo(manifest = {}) {
  return readyChannelVideos(manifest)[0] || null;
}

export function videoInputFromDraft(value = {}, channel = {}) {
  const defaults = channel.defaults || {};
  const priority = Number(value.priority);
  return {
    title: text(value.title).trim(),
    hook: text(value.hook).trim(),
    angle: text(value.angle).trim(),
    pillar: text(value.pillar).trim(),
    kind: text(value.kind, defaults.kind || 'story') === 'animation' ? 'animation' : 'story',
    style: text(value.style, defaults.style || ''),
    priority: Number.isFinite(priority) ? Math.max(0, Math.min(100, Math.round(priority))) : 50,
    status: 'ready',
  };
}

export function videoDraft(value = {}, channel = {}) {
  const defaults = channel.defaults || {};
  return {
    title: text(value.title),
    hook: text(value.hook),
    angle: text(value.angle),
    pillar: text(value.pillar),
    kind: text(value.kind, defaults.kind || 'story') === 'animation' ? 'animation' : 'story',
    style: text(value.style, defaults.style || ''),
    priority: positiveNumber(value.priority, 50),
  };
}

export function durationLabel(value) {
  const seconds = positiveNumber(value, 0);
  if (!seconds) return 'No duration set';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes}m ${remaining}s` : `${minutes} min`;
}
