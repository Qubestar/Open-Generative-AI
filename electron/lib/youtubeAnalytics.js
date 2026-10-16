// Optional private YouTube Analytics boundary.
//
// The injected tokenProvider owns OAuth setup, encrypted refresh-token storage,
// and scope consent. It must expose getAccessToken({ scopes }) and return only
// a short-lived access-token string. This service never returns or logs that
// token, accepts no API key, and calls only the two read-only endpoints below.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const YOUTUBE_ANALYTICS_REPORT_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
// The canonical YouTube Data API host includes `/youtube/v3` in its path.
const YOUTUBE_OWNED_CHANNEL_URL = 'https://youtube.googleapis.com/youtube/v3/channels';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PRIVATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORT_ROWS = 10_000;
const REPORT_PAGE_SIZE = 200;

const REQUIRED_READONLY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
]);

function publicError(code, message) {
  const error = new Error(message);
  error.name = 'YouTubeAnalyticsError';
  error.code = code;
  return error;
}

function clone(value) { return structuredClone(value); }

function nowMs(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw publicError('INVALID_CLOCK', 'The analytics clock is invalid.');
  return date.getTime();
}

function boundedTtl(value) {
  if (value === undefined) return DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(value) || value < 0) throw new Error('cacheTtlMs must be a non-negative number.');
  return Math.min(Math.floor(value), MAX_CACHE_TTL_MS);
}

function readOnlyReportParams(range, startIndex) {
  return new URLSearchParams({
    ids: 'channel==MINE',
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: 'day,video',
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained',
    sort: 'day,video',
    maxResults: String(REPORT_PAGE_SIZE),
    startIndex: String(startIndex),
  });
}

function responseDetail(response) {
  return response?.status === 401 || response?.status === 403
    ? publicError('YOUTUBE_ANALYTICS_UNAUTHORIZED', 'Google authorization for YouTube Analytics is unavailable or expired.')
    : publicError('YOUTUBE_ANALYTICS_API_ERROR', 'YouTube Analytics could not load this report right now.');
}

function totalResults(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_REPORT_ROWS) {
    throw publicError('YOUTUBE_ANALYTICS_RESULT_LIMIT', `YouTube Analytics returned more than ${MAX_REPORT_ROWS} report rows.`);
  }
  return result;
}

function createYouTubeAnalytics(deps = {}) {
  const fetchApi = deps.fetch || globalThis.fetch;
  const tokenProvider = deps.tokenProvider || deps.oauth;
  const clock = deps.clock || (() => new Date());
  const cache = deps.cache || new Map();
  const cacheTtlMs = boundedTtl(deps.cacheTtlMs);
  const loadCore = deps.core || (() => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'core', 'index.js')).href));
  if (typeof fetchApi !== 'function') throw new Error('fetch is unavailable for private YouTube Analytics.');
  if (!tokenProvider || typeof tokenProvider.getAccessToken !== 'function') {
    throw new Error('Private YouTube Analytics requires an injected OAuth token provider.');
  }

  function purgeCache() {
    const current = nowMs(clock);
    for (const [key, entry] of cache) {
      if (!entry || !Number.isFinite(entry.expiresAt) || !Number.isFinite(entry.purgeAt) || current >= entry.expiresAt || current >= entry.purgeAt) cache.delete(key);
    }
  }

  async function accessToken() {
    try {
      const token = await tokenProvider.getAccessToken({ scopes: [...REQUIRED_READONLY_SCOPES] });
      if (typeof token !== 'string' || !token.trim()) throw new Error('empty access token');
      return token.trim();
    } catch {
      throw publicError('YOUTUBE_ANALYTICS_UNAUTHORIZED', 'Google authorization for YouTube Analytics is unavailable or expired.');
    }
  }

  async function getJson(url) {
    const token = await accessToken();
    let response;
    try {
      response = await fetchApi(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    } catch {
      throw publicError('YOUTUBE_ANALYTICS_NETWORK_ERROR', 'Could not connect to YouTube Analytics. Check your connection and try again.');
    }
    if (!response?.ok) throw responseDetail(response);
    try {
      const body = await response.json();
      if (!body || typeof body !== 'object') throw new Error('invalid JSON');
      return body;
    } catch {
      throw publicError('INVALID_YOUTUBE_ANALYTICS_RESPONSE', 'YouTube returned an unreadable analytics response.');
    }
  }

  function cached(key) {
    purgeCache();
    const entry = cache.get(key);
    return entry ? clone(entry.result) : null;
  }

  function cacheResult(key, result) {
    if (cacheTtlMs === 0) return null;
    const current = nowMs(clock);
    // Only normalized output is cached. Raw reports are never stored, and this
    // in-memory entry expires within 24h (well before the 30-day hard purge).
    cache.set(key, {
      result: clone(result),
      expiresAt: current + cacheTtlMs,
      purgeAt: current + Math.min(MAX_PRIVATE_RETENTION_MS, cacheTtlMs),
    });
    return new Date(current + cacheTtlMs).toISOString();
  }

  async function ownedChannel(core) {
    const url = new URL(YOUTUBE_OWNED_CHANNEL_URL);
    url.search = new URLSearchParams({ part: 'id,snippet', mine: 'true' }).toString();
    return core.normalizeOwnedYouTubeChannel(await getJson(url.toString()));
  }

  async function report(core, range) {
    let headers = null;
    let rows = [];
    let expected = null;
    let startIndex = 1;
    while (expected === null || rows.length < expected) {
      const url = new URL(YOUTUBE_ANALYTICS_REPORT_URL);
      url.search = readOnlyReportParams(range, startIndex).toString();
      const page = await getJson(url.toString());
      if (!Array.isArray(page.columnHeaders) || !Array.isArray(page.rows)) {
        throw publicError('INVALID_YOUTUBE_ANALYTICS_RESPONSE', 'YouTube returned an invalid analytics report.');
      }
      if (headers && JSON.stringify(headers) !== JSON.stringify(page.columnHeaders)) {
        throw publicError('INVALID_YOUTUBE_ANALYTICS_RESPONSE', 'YouTube returned inconsistent analytics report columns.');
      }
      headers = page.columnHeaders;
      if (expected === null) expected = totalResults(page.totalResults);
      if (rows.length + page.rows.length > expected) {
        throw publicError('INVALID_YOUTUBE_ANALYTICS_RESPONSE', 'YouTube returned an invalid analytics report size.');
      }
      rows = rows.concat(page.rows);
      if (rows.length === expected) break;
      if (page.rows.length === 0) throw publicError('INVALID_YOUTUBE_ANALYTICS_RESPONSE', 'YouTube returned an incomplete analytics report.');
      startIndex += page.rows.length;
    }
    return core.normalizeYouTubeAnalyticsReport({ columnHeaders: headers || [], rows }, range);
  }

  async function analyze(input, { forceRefresh = false } = {}) {
    const core = await loadCore();
    const range = core.normalizeYouTubeAnalyticsRequest(input, { clock });
    const key = `${range.startDate}:${range.endDate}`;
    if (!forceRefresh) {
      const hit = cached(key);
      if (hit) return { ...hit, cache: { status: 'hit', expiresAt: hit.cache?.expiresAt || null } };
    }
    const channel = await ownedChannel(core);
    const normalized = await report(core, range);
    const result = { ...normalized, channel, collectedAt: new Date(nowMs(clock)).toISOString() };
    const expiresAt = cacheResult(key, result);
    return { ...clone(result), cache: { status: 'miss', expiresAt } };
  }

  function clearCache() { cache.clear(); }
  return { analyze, clearCache, purgeCache, cacheSize: () => { purgeCache(); return cache.size; } };
}

module.exports = {
  createYouTubeAnalytics,
  REQUIRED_READONLY_SCOPES,
  YOUTUBE_ANALYTICS_REPORT_URL,
  YOUTUBE_OWNED_CHANNEL_URL,
  MAX_CACHE_TTL_MS,
  MAX_PRIVATE_RETENTION_MS,
  MAX_REPORT_ROWS,
};
