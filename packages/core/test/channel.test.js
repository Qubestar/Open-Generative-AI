import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHANNEL_MANIFEST_NAME,
  TRACKER_COLUMNS,
  ChannelStore,
  ChannelWorkspace,
  createChannelManifest,
  addVideo,
  getVideo,
  transitionVideo,
  nextReady,
  claimVideo,
  releaseClaim,
  recoverStaleClaims,
  linkProduction,
  importTrackerRows,
  exportTrackerRows,
  trackerRowMetadata,
} from '../index.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-channel-'));

function makeIds() {
  let index = 0;
  return prefix => `${prefix}_test${++index}`;
}

function fixedClock(value = '2026-09-22T12:00:00.000Z') {
  return () => new Date(value);
}

function row({ status = 'Draft', number = '1', title, hook = '', angle = '' } = {}) {
  const values = Array(21).fill('');
  values[0] = status;
  values[1] = number;
  values[2] = title;
  values[3] = hook;
  values[4] = angle;
  return values;
}

test('ChannelStore persists a versioned snapshot and supports safe create/load/list/update', () => {
  const ids = makeIds();
  const root = tmpDir();
  const store = new ChannelStore(root, { clock: fixedClock(), idGenerator: ids });
  const workspace = store.create({ name: 'Science mysteries', strategy: { language: 'English' } });
  const ready = workspace.addVideo({ title: 'Why stars die', priority: 90 });
  workspace.updateVideo(ready.id, { hook: 'The ending is not what you expect' });

  const manifestPath = path.join(root, workspace.manifest.id, CHANNEL_MANIFEST_NAME);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version, 1);
  const loaded = store.load(workspace.manifest.id);
  assert.equal(loaded.getVideo(ready.id).hook, 'The ending is not what you expect');
  assert.equal(store.list().length, 1);
  assert.equal(store.update(workspace.manifest.id, { name: 'Cosmic mysteries' }).name, 'Cosmic mysteries');
  assert.throws(() => store.load('../channel_escape'), /filesystem-safe stable ID/);
});

test('queue transitions are bounded and nextReady orders only ready work by priority then sequence', () => {
  const ids = makeIds();
  const options = { clock: fixedClock(), idGenerator: ids };
  let manifest = createChannelManifest({ name: 'Queue' }, options);
  manifest = addVideo(manifest, { title: 'Draft', sequence: 1, priority: 100 }, options);
  manifest = addVideo(manifest, { title: 'Lower priority', sequence: 3, priority: 40, status: 'ready' }, options);
  manifest = addVideo(manifest, { title: 'Earlier ready', sequence: 2, priority: 80, status: 'ready' }, options);
  manifest = addVideo(manifest, { title: 'Later ready', sequence: 4, priority: 80, status: 'ready' }, options);
  assert.equal(nextReady(manifest).title, 'Earlier ready');

  const draft = manifest.videos[0];
  assert.throws(() => transitionVideo(manifest, draft.id, 'producing', options), /Illegal video status transition/);
  manifest = transitionVideo(manifest, draft.id, 'ready', options);
  assert.equal(nextReady(manifest).title, 'Draft');
  manifest = transitionVideo(manifest, draft.id, 'blocked', options);
  assert.equal(nextReady(manifest).title, 'Earlier ready');
});

test('claims are explicit, ownership-checked, and stale claims recover only to ready', () => {
  const ids = makeIds();
  let current = '2026-09-22T12:00:00.000Z';
  const clock = () => new Date(current);
  const options = { clock, idGenerator: ids };
  let manifest = createChannelManifest({ name: 'Claims' }, options);
  manifest = addVideo(manifest, { title: 'Claim me', status: 'ready' }, options);
  const videoId = manifest.videos[0].id;
  manifest = claimVideo(manifest, videoId, { userId: 'luke', deviceId: 'macbook', leaseMs: 60_000, clock });
  assert.equal(getVideo(manifest, videoId).status, 'claimed');
  assert.throws(() => releaseClaim(manifest, videoId, { userId: 'other', clock }), /claiming user/);
  assert.deepEqual(recoverStaleClaims(manifest, { clock }).recoveredIds, []);
  current = '2026-09-22T12:01:00.001Z';
  const recovered = recoverStaleClaims(manifest, { clock });
  assert.deepEqual(recovered.recoveredIds, [videoId]);
  manifest = recovered.manifest;
  assert.equal(getVideo(manifest, videoId).status, 'ready');
  manifest = claimVideo(manifest, videoId, { userId: 'luke', deviceId: 'macbook', leaseMs: 60_000, clock });
  manifest = releaseClaim(manifest, videoId, { userId: 'luke', deviceId: 'macbook', clock });
  assert.equal(getVideo(manifest, videoId).claim, null);
});

test('linkProduction creates a durable project link and begins production from an explicit claim', () => {
  const ids = makeIds();
  const options = { clock: fixedClock(), idGenerator: ids };
  let manifest = createChannelManifest({ name: 'Production' }, options);
  manifest = addVideo(manifest, { title: 'Linked work', status: 'ready' }, options);
  const videoId = manifest.videos[0].id;
  manifest = claimVideo(manifest, videoId, { userId: 'luke', deviceId: 'mac', clock: options.clock });
  manifest = linkProduction(manifest, videoId, 'proj_story001', options);
  assert.deepEqual(getVideo(manifest, videoId).productionProjectId, 'proj_story001');
  assert.equal(getVideo(manifest, videoId).status, 'producing');
});

test('21-column tracker import/export keeps IDs stable when rows are reordered', () => {
  const ids = makeIds();
  const options = { clock: fixedClock(), idGenerator: ids };
  const original = createChannelManifest({ name: 'Tracker' }, options);
  const imported = importTrackerRows(original, [
    Array.from(TRACKER_COLUMNS),
    row({ status: 'Ready', number: '7', title: 'First title', hook: 'first hook', angle: 'first angle' }),
    row({ status: 'Draft', number: '8', title: 'Second title', hook: 'second hook', angle: 'second angle' }),
  ], options);
  assert.equal(exportTrackerRows(imported.manifest).every(values => values.length === 21), true);
  const [firstId, secondId] = imported.importedIds;
  const reorderedMetadata = [
    { videoId: secondId, row: 2, revision: 1 },
    { videoId: firstId, row: 3, revision: 1 },
  ];
  const reordered = importTrackerRows(imported.manifest, [
    Array.from(TRACKER_COLUMNS),
    row({ status: 'Draft', number: '8', title: 'Second title edited', hook: 'second hook', angle: 'second angle' }),
    row({ status: 'Ready', number: '7', title: 'First title edited', hook: 'first hook', angle: 'first angle' }),
  ], { ...options, metadata: reorderedMetadata });
  assert.equal(getVideo(reordered.manifest, firstId).title, 'First title edited');
  assert.equal(getVideo(reordered.manifest, firstId).sheet.lastKnownRow, 3);
  assert.equal(getVideo(reordered.manifest, secondId).title, 'Second title edited');
  assert.equal(getVideo(reordered.manifest, secondId).sheet.lastKnownRow, 2);
  assert.deepEqual(trackerRowMetadata(reordered.manifest).map(value => value.videoId).sort(), [firstId, secondId].sort());
});

test('malformed manifests are rejected before a workspace is opened', () => {
  const dir = tmpDir();
  const manifest = createChannelManifest({ id: 'channel_valid', name: 'Valid' }, { clock: fixedClock() });
  manifest.version = 2;
  fs.writeFileSync(path.join(dir, CHANNEL_MANIFEST_NAME), JSON.stringify(manifest));
  assert.throws(() => ChannelWorkspace.load(dir), /manifest.version: expected 1/);

  const invalidClaim = createChannelManifest({ id: 'channel_claim', name: 'Bad claim' }, { clock: fixedClock() });
  invalidClaim.videos.push({
    id: 'video_claim', sequence: 1, title: 'bad', hook: '', angle: '', pillar: '', kind: 'story', style: '', priority: 1,
    status: 'claimed', claim: null, productionProjectId: null, sheet: { lastKnownRow: null, revision: 0 },
    trackerFields: Object.fromEntries(['status', 'videoNumber', 'workingTitle', 'hook', 'topicAngle', 'script', 'voiceover', 'images', 'mp4File', 'description', 'tags', 'hashtags', 'thumbnail', 'publishDate', 'youtubeLink', 'notes', 'agent', 'claimedUtc', 'driveFileId', 'optimized', 'thumbnailFileId'].map(key => [key, ''])),
    createdAt: '2026-09-22T12:00:00.000Z', updatedAt: '2026-09-22T12:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, CHANNEL_MANIFEST_NAME), JSON.stringify(invalidClaim));
  assert.throws(() => ChannelWorkspace.load(dir), /claim: is required while status is claimed/);
});
