import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelAnalysisError,
  buildChannelOpportunityAnalysis,
  normalizeYouTubeChannel,
  normalizeYouTubeVideos,
  parseYouTubeChannelInput,
  parseYouTubeDurationSeconds,
} from '../index.js';

const profileFixture = {
  id: 'UCexampleChannel1234567890',
  snippet: {
    title: 'Evidence Channel', customUrl: '@evidence', publishedAt: '2022-01-01T00:00:00Z',
    thumbnails: { medium: { url: 'https://img.example/profile.jpg' } },
  },
  contentDetails: { relatedPlaylists: { uploads: 'UUexampleUploads' } },
  statistics: { subscriberCount: '1200', viewCount: '45000', videoCount: '12', hiddenSubscriberCount: false },
};

const video = (id, { views, likes, comments, publishedAt, duration = 'PT4M10S' }) => ({
  id,
  snippet: { title: `Video ${id}`, description: 'Public description', publishedAt, thumbnails: { high: { url: `https://img.example/${id}.jpg` } } },
  contentDetails: { duration },
  statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
});

test('parses documented YouTube channel forms without accepting unrelated URLs', () => {
  assert.deepEqual(parseYouTubeChannelInput('@Evidence_Channel'), { kind: 'handle', value: 'Evidence_Channel', canonical: '@Evidence_Channel' });
  assert.deepEqual(parseYouTubeChannelInput('https://www.youtube.com/@Evidence_Channel/videos'), { kind: 'handle', value: 'Evidence_Channel', canonical: '@Evidence_Channel' });
  assert.deepEqual(parseYouTubeChannelInput('youtube.com/channel/UCexampleChannel1234567890'), { kind: 'channelId', value: 'UCexampleChannel1234567890', canonical: 'UCexampleChannel1234567890' });
  assert.throws(() => parseYouTubeChannelInput('https://example.com/@evidence'), error => error instanceof ChannelAnalysisError && error.code === 'INVALID_CHANNEL_INPUT');
});

test('normalizes only public channel/video fields and produces stable explainable opportunity evidence', () => {
  const profile = normalizeYouTubeChannel(profileFixture);
  const videos = normalizeYouTubeVideos([
    video('old', { views: 10_000, likes: 200, comments: 50, publishedAt: '2026-01-01T00:00:00Z' }),
    video('recent', { views: 10_000, likes: 900, comments: 100, publishedAt: '2026-09-18T00:00:00Z', duration: 'PT55S' }),
  ], ['recent', 'old']);
  assert.equal(profile.metrics.subscribers, 1200);
  assert.equal(profile.uploadsPlaylistId, 'UUexampleUploads');
  assert.equal(videos[0].videoId, 'recent');
  assert.equal(videos[0].durationSec, 55);
  assert.equal(parseYouTubeDurationSeconds('P1DT2H3M4S'), 93_784);
  assert.equal(parseYouTubeDurationSeconds('not-a-duration'), null);

  const first = buildChannelOpportunityAnalysis(profile, videos, { collectedAt: '2026-09-22T00:00:00.000Z' });
  const second = buildChannelOpportunityAnalysis(profile, videos, { collectedAt: '2026-09-22T00:00:00.000Z' });
  assert.deepEqual(first, second);
  assert.equal(first.scoreName, 'Opportunity score');
  assert.match(first.disclaimer, /not a prediction or guarantee/i);
  assert.equal(first.opportunities[0].videoId, 'recent');
  assert.equal(first.opportunities[0].evidence.map(item => item.signal).join(','), 'relative_views_per_day,recency,public_engagement');
  assert.equal(first.opportunities[0].score <= 100, true);
});

test('rejects a channel response with no uploads playlist instead of inventing a research result', () => {
  const noUploads = structuredClone(profileFixture);
  delete noUploads.contentDetails.relatedPlaylists.uploads;
  assert.throws(() => normalizeYouTubeChannel(noUploads), error => error instanceof ChannelAnalysisError && error.code === 'INVALID_YOUTUBE_RESPONSE');
});
