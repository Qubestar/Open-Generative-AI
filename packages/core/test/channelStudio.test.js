import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  channelInputFromDraft,
  channelVideos,
  groupedChannelVideos,
  nextReadyChannelVideo,
  videoInputFromDraft,
  researchInputFromDraft,
  plannerInputFromDraft,
  normalizePlanItems,
} from '../../studio/src/channelStudioModel.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const studioSource = fs.readFileSync(path.resolve(testDir, '..', '..', 'studio', 'src', 'components', 'ChannelsStudio.jsx'), 'utf8');
const shellSource = fs.readFileSync(path.resolve(testDir, '..', '..', '..', 'components', 'StandaloneShell.js'), 'utf8');

test('channel draft produces a durable local workspace shape with production defaults', () => {
  const input = channelInputFromDraft({
    name: '  Curious World  ', language: 'Polish', audience: 'Curious adults',
    positioning: 'Clear science stories', kind: 'animation', style: 'paper-stop-motion',
    aspect: '9:16', durationSec: '75',
  });
  assert.deepEqual(input, {
    name: 'Curious World',
    strategy: { language: 'Polish', audience: 'Curious adults', positioning: 'Clear science stories' },
    defaults: { kind: 'animation', style: 'paper-stop-motion', aspect: '9:16', durationSec: 75 },
  });
});

test('queue groups are status based and next ready chooses highest priority before sequence', () => {
  const manifest = { videos: [
    { id: 'published', sequence: 1, title: 'Published', status: 'published', priority: 100 },
    { id: 'ready-later', sequence: 4, title: 'Later', status: 'ready', priority: 60 },
    { id: 'ready-next', sequence: 9, title: 'Next', status: 'ready', priority: 80 },
    { id: 'blocked', sequence: 2, title: 'Blocked', status: 'blocked', priority: 90 },
  ] };
  assert.equal(nextReadyChannelVideo(manifest).id, 'ready-next');
  assert.deepEqual(groupedChannelVideos(manifest).map(group => [group.id, group.videos.length]), [
    ['ready', 2], ['production', 0], ['attention', 1], ['rendered', 0], ['scheduled', 0], ['published', 1], ['archived', 0],
  ]);
  assert.equal(channelVideos({ videos: [{ id: 'unknown', title: 'Unknown', status: 'other' }] })[0].status, 'ready');
});

test('manual idea inputs remain ready and inherit the active channel defaults', () => {
  const input = videoInputFromDraft({ title: '  A strong title ', priority: '180' }, {
    defaults: { kind: 'animation', style: 'editorial-collage' },
  });
  assert.equal(input.title, 'A strong title');
  assert.equal(input.kind, 'animation');
  assert.equal(input.style, 'editorial-collage');
  assert.equal(input.priority, 100);
  assert.equal(input.status, 'ready');
});

test('channel research modes produce stable bridge payloads and plan items are editable', () => {
  assert.deepEqual(researchInputFromDraft({ sourceMode: 'examples', exampleUrls: [' https://a.test ', '', 'https://b.test', 'https://c.test'], goals: 'Learn' }), {
    mode: 'examples', profileUrl: '', exampleUrls: ['https://a.test', 'https://b.test', 'https://c.test'], niche: '', goals: 'Learn',
  });
  assert.deepEqual(plannerInputFromDraft({ count: '20', niche: 'science', goals: 'Useful', referenceUrls: [' https://a.test '], agentId: 'codex<script>', provider: 'agent', model: 'openai/gpt-5.1' }), {
    count: 20, niche: 'science', goals: 'Useful', referenceUrls: ['https://a.test'], agentId: 'codexscript', provider: 'agent', model: 'openai/gpt-5.1',
  });
  assert.equal(normalizePlanItems({ items: [{ title: 'Idea', selected: false }] })[0].selected, false);
});

test('Channels is the primary route and UI treats the desktop bridge as optional', () => {
  assert.match(shellSource, /\{ id: 'channels', label: 'Channels' \}/);
  assert.match(shellSource, /activeTab === 'channels'.*<ChannelsStudio\b/s);
  assert.match(studioSource, /typeof window !== 'undefined' && window\.channels\?\.isElectron/);
  assert.match(studioSource, /Analyze public profile/);
  assert.match(studioSource, /Generate draft/);
  assert.match(studioSource, /addPlanned/);
  assert.match(studioSource, /Create next video/);
  assert.match(studioSource, /Google Tracker/);
  assert.match(studioSource, /bridge\?\.claimNext/);
  assert.match(studioSource, /bridge\?\.claimVideo/);
});
