import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createYouTubeChannelAnalysis } = require('../../../electron/lib/youtubeChannelAnalysis.js');
const coreUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js')).href;

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fixtures() {
  return {
    channel: {
      items: [{
        id: 'UCexampleChannel1234567890',
        snippet: { title: 'Evidence Channel', customUrl: '@evidence', publishedAt: '2022-01-01T00:00:00Z', thumbnails: { default: { url: 'https://img.example/channel.jpg' } } },
        contentDetails: { relatedPlaylists: { uploads: 'UUexampleUploads' } },
        statistics: { subscriberCount: '42', viewCount: '9000', videoCount: '2', hiddenSubscriberCount: false },
      }],
    },
    playlist: { items: [{ contentDetails: { videoId: 'vid-a' } }, { contentDetails: { videoId: 'vid-b' } }] },
    videos: { items: [
      { id: 'vid-b', snippet: { title: 'Second', publishedAt: '2026-09-19T00:00:00Z', thumbnails: { high: { url: 'https://img.example/b.jpg' } } }, contentDetails: { duration: 'PT2M' }, statistics: { viewCount: '500', likeCount: '25', commentCount: '3' } },
      { id: 'vid-a', snippet: { title: 'First', publishedAt: '2026-08-01T00:00:00Z', thumbnails: { high: { url: 'https://img.example/a.jpg' } } }, contentDetails: { duration: 'PT4M' }, statistics: { viewCount: '600', likeCount: '10', commentCount: '1' } },
    ] },
  };
}

function service(fetch, options = {}) {
  return createYouTubeChannelAnalysis({
    fetch,
    core: () => import(coreUrl),
    getSecret: id => id === 'youtube' ? 'main-process-only-key' : '',
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    ...options,
  });
}

test('uses only the documented channel, uploads playlist, and batched videos endpoints and caches the normalized result', async () => {
  const calls = [];
  const data = fixtures();
  const fetch = async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    assert.equal(parsed.searchParams.get('key'), 'main-process-only-key');
    if (parsed.pathname.endsWith('/channels')) {
      assert.equal(parsed.searchParams.get('forHandle'), 'evidence');
      return json(data.channel);
    }
    if (parsed.pathname.endsWith('/playlistItems')) {
      assert.equal(parsed.searchParams.get('playlistId'), 'UUexampleUploads');
      assert.equal(parsed.searchParams.get('maxResults'), '50');
      return json(data.playlist);
    }
    if (parsed.pathname.endsWith('/videos')) {
      assert.equal(parsed.searchParams.get('id'), 'vid-a,vid-b');
      return json(data.videos);
    }
    throw new Error(`Unexpected endpoint ${parsed.pathname}`);
  };
  const analysis = service(fetch);
  const first = await analysis.analyze('https://youtube.com/@evidence/videos');
  const second = await analysis.analyze('@evidence');

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.pathname), ['/youtube/v3/channels', '/youtube/v3/playlistItems', '/youtube/v3/videos']);
  assert.equal(first.cache.status, 'miss');
  assert.equal(second.cache.status, 'hit');
  assert.equal(first.profile.channelId, 'UCexampleChannel1234567890');
  assert.deepEqual(first.videos.map(video => video.videoId), ['vid-a', 'vid-b']);
  assert.match(first.analysis.disclaimer, /not a prediction or guarantee/i);
  assert.equal(JSON.stringify(first).includes('main-process-only-key'), false);
});

test('surfaces quota failures and missing keys without issuing undocumented requests', async () => {
  let calls = 0;
  const quotaFetch = async () => {
    calls += 1;
    return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
  };
  await assert.rejects(service(quotaFetch).analyze('@evidence'), error => error.code === 'YOUTUBE_QUOTA_EXCEEDED');
  assert.equal(calls, 1);

  const noKey = createYouTubeChannelAnalysis({
    fetch: async () => { throw new Error('fetch must not run'); },
    core: () => import(coreUrl),
    getSecret: () => '',
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
  });
  await assert.rejects(noKey.analyze('@evidence'), error => error.code === 'YOUTUBE_API_KEY_MISSING');

  let environmentCalls = 0;
  const environmentKey = createYouTubeChannelAnalysis({
    fetch: async url => {
      environmentCalls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/youtube/v3/channels');
      assert.equal(parsed.searchParams.get('id'), 'UCexampleChannel1234567890');
      assert.equal(parsed.searchParams.get('key'), 'test-environment-key');
      return json({ items: [] });
    },
    core: () => import(coreUrl),
    getSecret: () => '',
    environment: { YOUTUBE_API_KEY: 'test-environment-key' },
    allowEnvironmentKey: true,
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
  });
  await assert.rejects(environmentKey.analyze('UCexampleChannel1234567890'), error => error.code === 'YOUTUBE_CHANNEL_NOT_FOUND');
  assert.equal(environmentCalls, 1);
});
