// Pure public-YouTube normalization and opportunity analysis.
// Network access, API keys, cache storage, and IPC belong in Electron's main
// process; this module is intentionally safe to share with every other surface.

export const YOUTUBE_ANALYSIS_VERSION = 1;
export const MAX_YOUTUBE_ANALYSIS_VIDEOS = 50;

export class ChannelAnalysisError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ChannelAnalysisError';
    this.code = code;
  }
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const HANDLE_RE = /^@([A-Za-z0-9._-]{3,100})$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{2,126}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  throw new ChannelAnalysisError(code, message);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asIsoDate(value) {
  const text = asString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function bestThumbnail(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return null;
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = asString(thumbnails[size]?.url);
    if (url) return url;
  }
  return null;
}

function clone(value) {
  return structuredClone(value);
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function parseYouTubeChannelInput(input) {
  const value = asString(input);
  if (!value) fail('INVALID_CHANNEL_INPUT', 'Enter a YouTube channel URL, @handle, or channel ID.');

  const handle = value.match(HANDLE_RE);
  if (handle) return { kind: 'handle', value: handle[1], canonical: `@${handle[1]}` };
  if (CHANNEL_ID_RE.test(value)) return { kind: 'channelId', value, canonical: value };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    fail('INVALID_CHANNEL_INPUT', 'Enter a valid YouTube channel URL, @handle, or channel ID.');
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    fail('INVALID_CHANNEL_INPUT', 'The channel URL must be from youtube.com.');
  }

  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (!segments.length) fail('INVALID_CHANNEL_INPUT', 'The YouTube URL must include a channel handle or channel ID.');
  if (segments[0].startsWith('@')) {
    const matched = segments[0].match(HANDLE_RE);
    if (matched) return { kind: 'handle', value: matched[1], canonical: `@${matched[1]}` };
  }
  if (segments[0] === 'channel' && CHANNEL_ID_RE.test(segments[1] || '')) {
    return { kind: 'channelId', value: segments[1], canonical: segments[1] };
  }
  fail('INVALID_CHANNEL_INPUT', 'Use a YouTube @handle or /channel/ channel ID URL.');
}

export function parseYouTubeDurationSeconds(value) {
  const duration = asString(value);
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match || ![match[1], match[2], match[3], match[4]].some(Boolean)) return null;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

export function normalizeYouTubeChannel(item) {
  if (!item || typeof item !== 'object' || !asString(item.id)) {
    fail('INVALID_YOUTUBE_RESPONSE', 'YouTube did not return a valid channel.');
  }
  const snippet = item.snippet || {};
  const contentDetails = item.contentDetails || {};
  const statistics = item.statistics || {};
  const uploadsPlaylistId = asString(contentDetails.relatedPlaylists?.uploads);
  if (!uploadsPlaylistId) fail('INVALID_YOUTUBE_RESPONSE', 'YouTube did not return this channel’s uploads playlist.');
  const customUrl = asString(snippet.customUrl);
  const handle = customUrl.startsWith('@') ? customUrl : null;
  return {
    channelId: asString(item.id),
    handle,
    title: asString(snippet.title) || 'Untitled channel',
    description: asString(snippet.description),
    customUrl: customUrl || null,
    publishedAt: asIsoDate(snippet.publishedAt),
    thumbnailUrl: bestThumbnail(snippet.thumbnails),
    uploadsPlaylistId,
    metrics: {
      subscribers: statistics.hiddenSubscriberCount ? null : asNonNegativeInteger(statistics.subscriberCount),
      views: asNonNegativeInteger(statistics.viewCount),
      videos: asNonNegativeInteger(statistics.videoCount),
      subscribersHidden: Boolean(statistics.hiddenSubscriberCount),
    },
  };
}

export function normalizeYouTubeVideo(item) {
  if (!item || typeof item !== 'object' || !asString(item.id)) {
    fail('INVALID_YOUTUBE_RESPONSE', 'YouTube returned an invalid video.');
  }
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const duration = asString(item.contentDetails?.duration);
  return {
    videoId: asString(item.id),
    title: asString(snippet.title) || 'Untitled video',
    description: asString(snippet.description),
    publishedAt: asIsoDate(snippet.publishedAt),
    thumbnailUrl: bestThumbnail(snippet.thumbnails),
    durationIso: duration || null,
    durationSec: parseYouTubeDurationSeconds(duration),
    metrics: {
      views: asNonNegativeInteger(statistics.viewCount),
      likes: asNonNegativeInteger(statistics.likeCount),
      comments: asNonNegativeInteger(statistics.commentCount),
    },
  };
}

export function normalizeYouTubeVideos(items, orderedIds = []) {
  const normalized = items.map(normalizeYouTubeVideo);
  const byId = new Map(normalized.map(video => [video.videoId, video]));
  const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
  const remaining = normalized.filter(video => !orderedIds.includes(video.videoId));
  return [...ordered, ...remaining].slice(0, MAX_YOUTUBE_ANALYSIS_VIDEOS);
}

function ageDays(publishedAt, collectedAtMs) {
  const publishedAtMs = Date.parse(publishedAt || '');
  return Number.isNaN(publishedAtMs) ? null : Math.max(1, (collectedAtMs - publishedAtMs) / DAY_MS);
}

function viewsPerDay(video, collectedAtMs) {
  const days = ageDays(video.publishedAt, collectedAtMs);
  return video.metrics.views === null || days === null ? null : video.metrics.views / days;
}

function performancePoints(ratio) {
  if (ratio >= 3) return 55;
  if (ratio >= 2) return 45;
  if (ratio >= 1.5) return 35;
  if (ratio >= 1) return 25;
  if (ratio >= 0.5) return 12;
  return 4;
}

function recencyPoints(days) {
  if (days === null) return 0;
  if (days <= 14) return 25;
  if (days <= 45) return 20;
  if (days <= 90) return 15;
  if (days <= 180) return 8;
  return 3;
}

function engagementPoints(video) {
  const views = video.metrics.views;
  const likes = video.metrics.likes;
  const comments = video.metrics.comments;
  if (!views || (likes === null && comments === null)) return { rate: null, points: 0 };
  const rate = ((likes || 0) + (comments || 0)) / views;
  if (rate >= 0.08) return { rate, points: 20 };
  if (rate >= 0.04) return { rate, points: 13 };
  if (rate >= 0.02) return { rate, points: 6 };
  return { rate, points: 0 };
}

export function buildChannelOpportunityAnalysis(profile, videos, { collectedAt = new Date().toISOString() } = {}) {
  const collectedAtMs = Date.parse(collectedAt);
  if (Number.isNaN(collectedAtMs)) fail('INVALID_ANALYSIS_INPUT', 'collectedAt must be a valid ISO date.');
  const normalizedVideos = videos.map(video => clone(video)).slice(0, MAX_YOUTUBE_ANALYSIS_VIDEOS);
  const rates = normalizedVideos.map(video => viewsPerDay(video, collectedAtMs)).filter(rate => rate !== null);
  const recentMedianViewsPerDay = median(rates);
  const opportunities = normalizedVideos.map(video => {
    const days = ageDays(video.publishedAt, collectedAtMs);
    const rate = viewsPerDay(video, collectedAtMs);
    const evidence = [];
    let score = 0;
    if (rate !== null && recentMedianViewsPerDay !== null && recentMedianViewsPerDay > 0) {
      const ratio = rate / recentMedianViewsPerDay;
      const points = performancePoints(ratio);
      score += points;
      evidence.push({
        signal: 'relative_views_per_day', points, value: round(rate), baseline: round(recentMedianViewsPerDay), ratio: round(ratio),
        explanation: `This video has ${round(ratio)}× the channel’s recent median views per day.`,
      });
    } else {
      evidence.push({ signal: 'relative_views_per_day', points: 0, explanation: 'There is not enough public view history to establish a channel baseline.' });
    }
    const freshness = recencyPoints(days);
    score += freshness;
    evidence.push({
      signal: 'recency', points: freshness, value: days === null ? null : round(days, 1),
      explanation: days === null ? 'YouTube did not provide a usable publication date.' : `Published ${round(days, 1)} days before collection.`,
    });
    const engagement = engagementPoints(video);
    score += engagement.points;
    evidence.push({
      signal: 'public_engagement', points: engagement.points, value: engagement.rate === null ? null : round(engagement.rate * 100, 2),
      explanation: engagement.rate === null ? 'Public likes or comments are unavailable for this video.' : `${round(engagement.rate * 100, 2)}% public likes and comments per view.`,
    });
    return { videoId: video.videoId, title: video.title, score: Math.min(100, score), evidence };
  }).sort((left, right) => right.score - left.score || left.videoId.localeCompare(right.videoId));

  return {
    version: YOUTUBE_ANALYSIS_VERSION,
    scoreName: 'Opportunity score',
    disclaimer: 'This score ranks public evidence from this channel’s recent uploads. It is not a prediction or guarantee of viral performance.',
    collectedAt: new Date(collectedAtMs).toISOString(),
    profile: { channelId: profile?.channelId || null, title: profile?.title || null },
    baseline: { videoCount: normalizedVideos.length, medianViewsPerDay: recentMedianViewsPerDay === null ? null : round(recentMedianViewsPerDay) },
    opportunities,
  };
}
