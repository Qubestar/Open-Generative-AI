import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  YOUTUBE_ANALYTICS_READONLY_SCOPES,
  normalizeYouTubeAnalyticsReport,
  normalizeYouTubeAnalyticsRequest,
} from '../index.js';

const require = createRequire(import.meta.url);
const {
  createYouTubeAnalytics,
  REQUIRED_READONLY_SCOPES,
  YOUTUBE_ANALYTICS_REPORT_URL,
  YOUTUBE_OWNED_CHANNEL_URL,
  MAX_CACHE_TTL_MS,
} = require('../../../electron/lib/youtubeAnalytics.js');
const coreUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')).href;

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const headers = ['day', 'video', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained'].map(name => ({ name }));

test('normalizes bounded day/video analytics into aggregate, trend, and video-ID maps', () => {
  const request = normalizeYouTubeAnalyticsRequest(
    { startDate: '2026-09-20', endDate: '2026-09-21' },
    { clock: () => new Date('2026-09-22T12:00:00.000Z') },
  );
  const normalized = normalizeYouTubeAnalyticsReport({
    columnHeaders: headers,
    rows: [
      ['2026-09-20', 'video-b', 10, 12.5, 30, 1],
      ['2026-09-20', 'video-a', 20, 20, 60, 2],
      ['2026-09-21', 'video-a', 5, 5, 90, 0],
    ],
  }, request);

  assert.deepEqual(normalized.aggregates, { views: 35, estimatedMinutesWatched: 37.5, averageViewDuration: 55.714, subscribersGained: 3 });
  assert.deepEqual(normalized.trends, [
    { day: '2026-09-20', views: 30, estimatedMinutesWatched: 32.5, averageViewDuration: 50, subscribersGained: 3 },
    { day: '2026-09-21', views: 5, estimatedMinutesWatched: 5, averageViewDuration: 90, subscribersGained: 0 },
  ]);
  assert.deepEqual(normalized.videos.map(video => video.videoId), ['video-a', 'video-b']);
  assert.deepEqual(normalized.videosById['video-a'], { videoId: 'video-a', views: 25, estimatedMinutesWatched: 25, averageViewDuration: 66, subscribersGained: 2 });
  assert.equal(JSON.stringify(normalized).includes('columnHeaders'), false);
});

test('rejects invalid, future, and over-365-day date ranges before a report can be requested', () => {
  const clock = () => new Date('2026-09-22T12:00:00.000Z');
  assert.throws(() => normalizeYouTubeAnalyticsRequest({ startDate: '2025-09-22', endDate: '2026-09-22' }, { clock }), error => error.code === 'DATE_RANGE_TOO_LARGE');
  assert.throws(() => normalizeYouTubeAnalyticsRequest({ startDate: '2026-09-23', endDate: '2026-09-23' }, { clock }), error => error.code === 'INVALID_DATE_RANGE');
  assert.throws(() => normalizeYouTubeAnalyticsReport({ columnHeaders: headers, rows: [['2026-09-19', 'video-a', 1, 1, 1, 1]] }, { startDate: '2026-09-20', endDate: '2026-09-20' }), error => error.code === 'INVALID_ANALYTICS_REPORT');
});

test('uses only injected OAuth access tokens and the two documented read-only endpoints', async () => {
  let now = Date.parse('2026-09-22T12:00:00.000Z');
  const calls = [];
  const scopeRequests = [];
  const service = createYouTubeAnalytics({
    core: () => import(coreUrl),
    clock: () => new Date(now),
    tokenProvider: { getAccessToken: async request => { scopeRequests.push(request); return 'short-lived-private-token'; } },
    fetch: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ parsed, options });
      assert.equal(parsed.searchParams.has('key'), false);
      assert.equal(options.headers.authorization, 'Bearer short-lived-private-token');
      if (parsed.toString().startsWith(YOUTUBE_OWNED_CHANNEL_URL)) {
        assert.equal(parsed.searchParams.get('mine'), 'true');
        assert.equal(parsed.searchParams.get('part'), 'id,snippet');
        return json({ items: [{ id: 'UCownedChannel123', snippet: { title: 'Private Channel' } }] });
      }
      assert.equal(parsed.toString().startsWith(YOUTUBE_ANALYTICS_REPORT_URL), true);
      assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        ids: 'channel==MINE', startDate: '2026-09-20', endDate: '2026-09-21', dimensions: 'day,video',
        metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained', sort: 'day,video', maxResults: '200', startIndex: '1',
      });
      return json({ columnHeaders: headers, totalResults: 2, rows: [
        ['2026-09-20', 'video-a', 5, 7, 40, 1],
        ['2026-09-21', 'video-a', 10, 15, 50, 0],
      ] });
    },
  });

  const first = await service.analyze({ startDate: '2026-09-20', endDate: '2026-09-21' });
  const second = await service.analyze({ startDate: '2026-09-20', endDate: '2026-09-21' });
  assert.equal(calls.length, 2);
  assert.equal(first.cache.status, 'miss');
  assert.equal(second.cache.status, 'hit');
  assert.deepEqual(first.channel, { channelId: 'UCownedChannel123', title: 'Private Channel' });
  assert.deepEqual(scopeRequests, [{ scopes: [...REQUIRED_READONLY_SCOPES] }, { scopes: [...REQUIRED_READONLY_SCOPES] }]);
  assert.deepEqual(REQUIRED_READONLY_SCOPES, YOUTUBE_ANALYTICS_READONLY_SCOPES);
  assert.equal(JSON.stringify(first).includes('short-lived-private-token'), false);

  now += MAX_CACHE_TTL_MS + 1;
  assert.equal(service.cacheSize(), 0);
});

test('fails closed without a token provider, masks provider errors, and validates ranges before OAuth', async () => {
  assert.throws(() => createYouTubeAnalytics({ fetch: async () => json({}) }), /injected OAuth token provider/);
  let providerCalls = 0;
  const service = createYouTubeAnalytics({
    core: () => import(coreUrl),
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    tokenProvider: { getAccessToken: async () => { providerCalls += 1; throw new Error('access_token=must-not-escape'); } },
    fetch: async () => { throw new Error('fetch must not run'); },
  });
  await assert.rejects(service.analyze({ startDate: '2025-09-22', endDate: '2026-09-22' }), error => error.code === 'DATE_RANGE_TOO_LARGE');
  assert.equal(providerCalls, 0);
  await assert.rejects(service.analyze({ startDate: '2026-09-22', endDate: '2026-09-22' }), error => error.code === 'YOUTUBE_ANALYTICS_UNAUTHORIZED' && !error.message.includes('must-not-escape'));
});
