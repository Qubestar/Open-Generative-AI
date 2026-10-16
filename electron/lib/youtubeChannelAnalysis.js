// Main-process client for the documented YouTube Data API v3 channel flow.
// The API key is resolved here and never returned to a renderer or core result.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getSecret: defaultGetSecret } = require('./secrets');
const { resolveRuntimePaths } = require('./runtimePaths');

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('clock must return a valid date');
  return date.toISOString();
}

function publicError(code, message, options) {
  const error = new Error(message, options);
  error.name = 'YouTubeChannelAnalysisError';
  error.code = code;
  return error;
}

function reasonFor(body) {
  const reasons = body?.error?.errors;
  return Array.isArray(reasons) ? reasons.map(item => item?.reason).find(Boolean) : null;
}

function messageFor(reason, status) {
  if (['quotaExceeded', 'dailyLimitExceeded', 'userRateLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
    return 'YouTube API quota is exhausted. Try again after the quota resets.';
  }
  if (status === 401 || reason === 'keyInvalid' || reason === 'ipRefererBlocked') {
    return 'The YouTube API key is invalid or not allowed for this app.';
  }
  if (status === 404 || reason === 'channelNotFound') return 'YouTube could not find that channel.';
  return 'YouTube could not load this channel right now.';
}

function apiError(reason, status) {
  const code = ['quotaExceeded', 'dailyLimitExceeded', 'userRateLimitExceeded', 'rateLimitExceeded'].includes(reason)
    ? 'YOUTUBE_QUOTA_EXCEEDED'
    : (status === 401 || reason === 'keyInvalid' || reason === 'ipRefererBlocked') ? 'YOUTUBE_API_KEY_INVALID' : 'YOUTUBE_API_ERROR';
  return publicError(code, messageFor(reason, status));
}

function safeItems(body, resource) {
  if (!body || !Array.isArray(body.items)) {
    throw publicError('INVALID_YOUTUBE_RESPONSE', `YouTube returned an invalid ${resource} response.`);
  }
  return body.items;
}

function clone(value) {
  return structuredClone(value);
}

function boundedTtl(value) {
  if (value === undefined) return DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(value) || value < 0) throw new Error('cacheTtlMs must be a non-negative number');
  return Math.min(Math.floor(value), MAX_CACHE_TTL_MS);
}

function createYouTubeChannelAnalysis(deps = {}) {
  const application = deps.app;
  const runtime = deps.runtime || (application ? resolveRuntimePaths({
    isPackaged: application.isPackaged,
    resourcesPath: process.resourcesPath,
    ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}),
  }) : null);
  const loadCore = deps.core || (() => {
    if (!runtime?.coreDir) throw new Error('A core loader is required for YouTube channel analysis.');
    return import(pathToFileURL(path.join(runtime.coreDir, 'index.js')).href);
  });
  const fetchApi = deps.fetch || globalThis.fetch;
  const getSecret = deps.getSecret || defaultGetSecret;
  const environment = deps.environment || process.env;
  const allowEnvironmentKey = deps.allowEnvironmentKey === true || process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
  const cache = deps.cache || new Map();
  const cacheTtlMs = boundedTtl(deps.cacheTtlMs);
  const clock = deps.clock || (() => new Date());
  const apiBase = String(deps.apiBase || API_BASE).replace(/\/$/, '');

  if (typeof fetchApi !== 'function') throw new Error('fetch is unavailable for YouTube channel analysis.');

  function apiKey() {
    const stored = getSecret('youtube');
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
    if (allowEnvironmentKey && typeof environment.YOUTUBE_API_KEY === 'string' && environment.YOUTUBE_API_KEY.trim()) {
      return environment.YOUTUBE_API_KEY.trim();
    }
    throw publicError('YOUTUBE_API_KEY_MISSING', 'Add a YouTube Data API key in Settings before analyzing a channel.');
  }

  async function request(resource, params) {
    const url = new URL(`${apiBase}/${resource}`);
    const search = new URLSearchParams(params);
    search.set('key', apiKey());
    url.search = search.toString();
    let response;
    try {
      response = await fetchApi(url.toString(), { method: 'GET' });
    } catch (cause) {
      throw publicError('YOUTUBE_NETWORK_ERROR', 'Could not connect to YouTube. Check your connection and try again.', { cause });
    }
    let body;
    try { body = await response.json(); }
    catch { throw publicError('INVALID_YOUTUBE_RESPONSE', 'YouTube returned an unreadable response.'); }
    if (!response.ok) throw apiError(reasonFor(body), response.status);
    return body;
  }

  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    const now = new Date(isoNow(clock)).getTime();
    if (now >= entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return { result: clone(entry.result), expiresAt: entry.expiresAt };
  }

  function cacheResult(keys, result) {
    if (cacheTtlMs <= 0) return null;
    const expiresAt = new Date(new Date(isoNow(clock)).getTime() + cacheTtlMs).toISOString();
    const entry = { result: clone(result), expiresAt: Date.parse(expiresAt) };
    for (const key of keys) cache.set(key, entry);
    return expiresAt;
  }

  async function analyze(input, { forceRefresh = false } = {}) {
    const core = await loadCore();
    const target = core.parseYouTubeChannelInput(input);
    const requestedKey = `${target.kind}:${target.value}`;
    if (!forceRefresh) {
      const hit = cached(requestedKey);
      if (hit) return { ...hit.result, cache: { status: 'hit', expiresAt: new Date(hit.expiresAt).toISOString() } };
    }

    const channelParams = { part: 'snippet,contentDetails,statistics' };
    channelParams[target.kind === 'handle' ? 'forHandle' : 'id'] = target.value;
    const channels = safeItems(await request('channels', channelParams), 'channel');
    if (!channels.length) throw publicError('YOUTUBE_CHANNEL_NOT_FOUND', 'YouTube could not find that channel.');
    const profile = core.normalizeYouTubeChannel(channels[0]);

    const orderedIds = [];
    let pageToken = null;
    while (orderedIds.length < core.MAX_YOUTUBE_ANALYSIS_VIDEOS) {
      const playlist = await request('playlistItems', {
        part: 'contentDetails', playlistId: profile.uploadsPlaylistId,
        maxResults: String(Math.min(50, core.MAX_YOUTUBE_ANALYSIS_VIDEOS - orderedIds.length)),
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of safeItems(playlist, 'uploads playlist')) {
        const id = item?.contentDetails?.videoId;
        if (typeof id === 'string' && id && !orderedIds.includes(id)) orderedIds.push(id);
        if (orderedIds.length >= core.MAX_YOUTUBE_ANALYSIS_VIDEOS) break;
      }
      pageToken = typeof playlist.nextPageToken === 'string' && playlist.nextPageToken ? playlist.nextPageToken : null;
      if (!pageToken) break;
    }

    let videos = [];
    if (orderedIds.length) {
      const body = await request('videos', {
        part: 'snippet,contentDetails,statistics',
        id: orderedIds.join(','),
        maxResults: String(core.MAX_YOUTUBE_ANALYSIS_VIDEOS),
      });
      videos = core.normalizeYouTubeVideos(safeItems(body, 'videos'), orderedIds);
    }
    const collectedAt = isoNow(clock);
    const result = {
      source: 'youtube-data-api-v3',
      collectedAt,
      profile,
      videos,
      analysis: core.buildChannelOpportunityAnalysis(profile, videos, { collectedAt }),
    };
    const expiresAt = cacheResult([requestedKey, `channelId:${profile.channelId}`], result);
    return { ...clone(result), cache: { status: 'miss', expiresAt } };
  }

  function clearCache() { cache.clear(); }
  return { analyze, clearCache, cacheSize: () => cache.size };
}

module.exports = { createYouTubeChannelAnalysis, DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS };
