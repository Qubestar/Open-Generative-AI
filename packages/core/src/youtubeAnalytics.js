// Pure normalization for optional, private YouTube Analytics reports.
// OAuth, network requests, tokens, persistence, and UI deliberately belong to
// the Electron boundary. This module only accepts the small report shape that
// the boundary requests and never retains its raw response.

export const YOUTUBE_ANALYTICS_VERSION = 1;
export const YOUTUBE_ANALYTICS_MAX_RANGE_DAYS = 365;
export const YOUTUBE_ANALYTICS_DIMENSIONS = Object.freeze(['day', 'video']);
export const YOUTUBE_ANALYTICS_METRICS = Object.freeze([
  'views',
  'estimatedMinutesWatched',
  'averageViewDuration',
  'subscribersGained',
]);

// These are the only scopes this optional feature needs. A main-process OAuth
// provider must obtain and retain credentials itself; core never sees them.
export const YOUTUBE_ANALYTICS_READONLY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
]);

const REQUIRED_COLUMNS = Object.freeze([...YOUTUBE_ANALYTICS_DIMENSIONS, ...YOUTUBE_ANALYTICS_METRICS]);
const DAY_MS = 24 * 60 * 60 * 1000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class YouTubeAnalyticsValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'YouTubeAnalyticsValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new YouTubeAnalyticsValidationError(code, message);
}

function isoDate(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('INVALID_DATE_RANGE', `${field} must use YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    fail('INVALID_DATE_RANGE', `${field} must be a valid UTC calendar date.`);
  }
  return { text, time: date.getTime() };
}

function todayDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date.');
  return date.toISOString().slice(0, 10);
}

function metric(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail('INVALID_ANALYTICS_REPORT', `${label} must be a non-negative number.`);
  return number;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function average(totalDuration, views) {
  return views > 0 ? rounded(totalDuration / views) : null;
}

function emptyTotals() {
  return { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, weightedDuration: 0 };
}

function outputTotals(totals) {
  return {
    views: rounded(totals.views),
    estimatedMinutesWatched: rounded(totals.estimatedMinutesWatched),
    averageViewDuration: average(totals.weightedDuration, totals.views),
    subscribersGained: rounded(totals.subscribersGained),
  };
}

function addTotals(target, row) {
  target.views += row.views;
  target.estimatedMinutesWatched += row.estimatedMinutesWatched;
  target.subscribersGained += row.subscribersGained;
  target.weightedDuration += row.averageViewDuration * row.views;
}

export function normalizeYouTubeAnalyticsRequest(input = {}, { clock = () => new Date() } = {}) {
  const start = isoDate(input.startDate, 'startDate');
  const end = isoDate(input.endDate, 'endDate');
  const today = isoDate(todayDate(clock), 'today');
  if (start.time > end.time) fail('INVALID_DATE_RANGE', 'startDate must be on or before endDate.');
  if (end.time > today.time) fail('INVALID_DATE_RANGE', 'endDate cannot be in the future.');
  const days = Math.floor((end.time - start.time) / DAY_MS) + 1;
  if (days > YOUTUBE_ANALYTICS_MAX_RANGE_DAYS) {
    fail('DATE_RANGE_TOO_LARGE', `Date ranges are limited to ${YOUTUBE_ANALYTICS_MAX_RANGE_DAYS} days.`);
  }
  return Object.freeze({ startDate: start.text, endDate: end.text, days });
}

export function normalizeOwnedYouTubeChannel(response) {
  if (!response || !Array.isArray(response.items)) fail('INVALID_CHANNEL_RESPONSE', 'YouTube returned an invalid owned-channel response.');
  if (response.items.length === 0) fail('OWNED_CHANNEL_NOT_FOUND', 'No YouTube channel is available for this Google account.');
  const item = response.items[0];
  const channelId = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!VIDEO_ID_RE.test(channelId)) fail('INVALID_CHANNEL_RESPONSE', 'YouTube returned an invalid channel ID.');
  const title = typeof item?.snippet?.title === 'string' ? item.snippet.title.trim().slice(0, 200) : '';
  return { channelId, title: title || null };
}

export function normalizeYouTubeAnalyticsReport(response, request) {
  const range = normalizeYouTubeAnalyticsRequest(request);
  const headers = response?.columnHeaders;
  const rows = response?.rows;
  if (!Array.isArray(headers) || !Array.isArray(rows)) fail('INVALID_ANALYTICS_REPORT', 'YouTube returned an invalid analytics report.');
  const names = headers.map(header => typeof header?.name === 'string' ? header.name : '');
  if (names.length !== REQUIRED_COLUMNS.length || REQUIRED_COLUMNS.some(name => !names.includes(name))) {
    fail('INVALID_ANALYTICS_REPORT', 'YouTube analytics columns did not match the requested day/video report.');
  }
  const positions = Object.fromEntries(names.map((name, index) => [name, index]));
  const totals = emptyTotals();
  const byDay = new Map();
  const byVideo = new Map();

  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length !== names.length) fail('INVALID_ANALYTICS_REPORT', 'YouTube returned an invalid analytics row.');
    const day = isoDate(raw[positions.day], 'analytics day');
    if (day.time < Date.parse(`${range.startDate}T00:00:00.000Z`) || day.time > Date.parse(`${range.endDate}T00:00:00.000Z`)) {
      fail('INVALID_ANALYTICS_REPORT', 'YouTube returned analytics outside the requested date range.');
    }
    const videoId = typeof raw[positions.video] === 'string' ? raw[positions.video].trim() : '';
    if (!VIDEO_ID_RE.test(videoId)) fail('INVALID_ANALYTICS_REPORT', 'YouTube returned an invalid analytics video ID.');
    const row = {
      day: day.text,
      videoId,
      views: metric(raw[positions.views], 'views'),
      estimatedMinutesWatched: metric(raw[positions.estimatedMinutesWatched], 'estimatedMinutesWatched'),
      averageViewDuration: metric(raw[positions.averageViewDuration], 'averageViewDuration'),
      subscribersGained: metric(raw[positions.subscribersGained], 'subscribersGained'),
    };
    addTotals(totals, row);
    const daily = byDay.get(row.day) || emptyTotals();
    addTotals(daily, row);
    byDay.set(row.day, daily);
    const video = byVideo.get(videoId) || emptyTotals();
    addTotals(video, row);
    byVideo.set(videoId, video);
  }

  const trends = [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, values]) => ({ day, ...outputTotals(values) }));
  const videos = [...byVideo.entries()]
    .map(([videoId, values]) => ({ videoId, ...outputTotals(values) }))
    .sort((left, right) => right.views - left.views || left.videoId.localeCompare(right.videoId));
  const videosById = Object.fromEntries(videos.map(video => [video.videoId, { ...video }]));

  return {
    version: YOUTUBE_ANALYTICS_VERSION,
    period: { startDate: range.startDate, endDate: range.endDate, days: range.days },
    aggregates: outputTotals(totals),
    trends,
    videos,
    videosById,
  };
}
