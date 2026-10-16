import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as actualCore from '../index.js';

const require = createRequire(import.meta.url);
const { createPublisherBridge, createLocalMockYouTubeServer } = require('../../../electron/lib/publisherBridge.js');
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function harness({ accessToken = 'mock_vault_token_v26_valid', ...bridgeDeps } = {}) {
  const handlers = new Map();
  const mockOAuth = {
    accessToken: async () => accessToken,
  };

  // Phase 3 item 1: every bridge test runs against a private mkdtemp userData
  // directory, so no test can read or write the real ~/.vidmyo. Callers that
  // pass their own app/userDataDir/queuePath keep full control.
  if (bridgeDeps.userDataDir === undefined && bridgeDeps.queuePath === undefined && !bridgeDeps.app) {
    bridgeDeps.userDataDir = tempDir('vidmyo-pub-userdata-');
  }

  const bridge = createPublisherBridge({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    core: async () => actualCore,
    googleOAuth: mockOAuth,
    ...bridgeDeps,
  });
  bridge.register();
  return { bridge, handlers };
}

test('publisherBridge connects to Google OAuth vault and enforces idempotency against duplicate uploads', async () => {
  const { handlers } = harness();
  const root = tempDir('vidmyo-pub-test-');
  const videoFile = path.join(root, 'video_to_publish.mp4');
  fs.writeFileSync(videoFile, 'sample video binary stream');

  const createSession = handlers.get('publisher:create-session');
  assert.ok(createSession);

  // 1. Create session successfully
  const res1 = await createSession(null, {
    channelId: 'UC_TEST_CHANNEL_123',
    videoPath: videoFile,
    metadata: {
      title: 'First Upload Test',
      description: 'Uploaded via Vidmyo Auto-Publisher V2.6',
    },
  });

  assert.equal(res1.ok, true);
  assert.ok(res1.record);
  assert.equal(res1.record.state, 'queued');
  assert.equal(res1.authReady, true);

  // 2. Duplicate submission with exact same file hash to same channel must be blocked
  const res2 = await createSession(null, {
    channelId: 'UC_TEST_CHANNEL_123',
    videoPath: videoFile,
    metadata: {
      title: 'Duplicate Attempt',
    },
  });

  assert.equal(res2.ok, false);
  assert.match(res2.error, /Duplicate publication blocked/);
});

test('publisher executes resumable upload against local mock server without making real external calls', async () => {
  const { handlers } = harness();
  const root = tempDir('vidmyo-pub-test-');
  const videoFile = path.join(root, 'video_render.mp4');
  fs.writeFileSync(videoFile, 'mp4 video payload bytes 12345');

  // Start local mock server
  const mockServer = createLocalMockYouTubeServer();
  const { baseUrl } = await mockServer.start();

  try {
    const createSession = handlers.get('publisher:create-session');
    const testMockUpload = handlers.get('publisher:test-mock-upload');

    const created = await createSession(null, {
      channelId: 'UC_MOCK_CHANNEL_ABC',
      videoPath: videoFile,
      metadata: {
        title: 'Local Mock Upload Test #Shorts',
        description: 'Testing against local loopback mock server',
      },
    });

    assert.equal(created.ok, true);
    const publishId = created.record.id;

    // Execute upload against local mock server
    const uploadRes = await testMockUpload(null, {
      publishId,
      mockBaseUrl: baseUrl,
    });

    assert.equal(uploadRes.ok, true);
    assert.equal(uploadRes.record.state, 'processing');
    assert.ok(uploadRes.record.remoteVideoId.startsWith('yt_mock_'));
    assert.equal(uploadRes.record.bytesUploaded, uploadRes.record.totalBytes);

    // Verify mock server received the video with authorization
    const uploaded = mockServer.getUploadedVideos();
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].videoId, uploadRes.record.remoteVideoId);
  } finally {
    await mockServer.stop();
  }
});

test('publisher:test-mock-upload rejects non-loopback URLs to protect user privacy', async () => {
  const { handlers } = harness();
  const root = tempDir('vidmyo-pub-privacy-');
  const videoFile = path.join(root, 'sensitive_video.mp4');
  fs.writeFileSync(videoFile, 'private personal footage content');

  const createSession = handlers.get('publisher:create-session');
  const testMockUpload = handlers.get('publisher:test-mock-upload');

  const created = await createSession(null, {
    channelId: 'UC_PRIVACY_TEST',
    videoPath: videoFile,
    metadata: { title: 'Sensitive Video' },
  });
  assert.equal(created.ok, true);

  // Attempt upload to an external domain
  const res = await testMockUpload(null, {
    publishId: created.record.id,
    mockBaseUrl: 'https://attacker.external.site:8080',
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /Privacy boundary violation/);
});

test('publisher:cancel aborts an in-flight mock upload through IPC and ends in cancelled', async () => {
  const { handlers } = harness();
  const root = tempDir('vidmyo-pub-cancel-');
  const videoFile = path.join(root, 'cancel_me.mp4');
  // Larger than one chunk at the default 256 KiB boundary would be slow —
  // the stall control holds the single-chunk PUT open instead.
  fs.writeFileSync(videoFile, Buffer.alloc(64 * 1024, 0x7a));

  const mockServer = createLocalMockYouTubeServer();
  const { baseUrl } = await mockServer.start();
  mockServer.control.stallNextChunk = true;

  try {
    const createSession = handlers.get('publisher:create-session');
    const testMockUpload = handlers.get('publisher:test-mock-upload');
    const cancel = handlers.get('publisher:cancel');

    const created = await createSession(null, {
      channelId: 'UC_CANCEL_MOCK',
      videoPath: videoFile,
      metadata: { title: 'Cancel In-flight' },
    });
    assert.equal(created.ok, true);
    const publishId = created.record.id;

    // Start the upload but do not await it — it blocks on the stalled chunk.
    const uploadPromise = testMockUpload(null, { publishId, mockBaseUrl: baseUrl });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 4000;
    while (mockServer.stats.stalledPending < 1 && Date.now() < deadline) await sleep(25);
    assert.equal(mockServer.stats.stalledPending, 1, 'server is holding the in-flight chunk');

    const cancelRes = await cancel(null, publishId);
    assert.equal(cancelRes.ok, true);
    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.record.state, 'cancelled');

    const uploadRes = await uploadPromise;
    // The upload promise resolves (AbortError handled) with the terminal record.
    const record = uploadRes.record;
    assert.equal(record.state, 'cancelled', 'in-flight upload ends in cancelled, not error');
    assert.equal(uploadRes.cancelled, true);

    // Transport-level abort observed by the server.
    const abortDeadline = Date.now() + 4000;
    while (mockServer.stats.abortedWhileStalled < 1 && Date.now() < abortDeadline) await sleep(25);
    assert.ok(mockServer.stats.abortedWhileStalled >= 1, 'in-flight HTTP request aborted');
    assert.equal(mockServer.getUploadedVideos().length, 0, 'no video completed');
  } finally {
    await mockServer.stop();
  }
});

test('publisherBridge persists the queue to disk and recovers a record killed mid-upload at startup', async () => {
  const userDataDir = tempDir('vidmyo-pub-userdata-');
  const appMock = { getPath: () => userDataDir };
  const queuePath = path.join(userDataDir, 'publisher-queue.json');
  const root = tempDir('vidmyo-pub-durability-');
  const videoFile = path.join(root, 'durable_video.mp4');
  fs.writeFileSync(videoFile, 'durable queue payload bytes');

  // ── First app run: queue is durable on disk (default = userData dir) ───
  const run1 = harness({ app: appMock });
  const created = await run1.handlers.get('publisher:create-session')(null, {
    channelId: 'UC_DURABILITY',
    videoPath: videoFile,
    metadata: { title: 'Durable Queue' },
  });
  assert.equal(created.ok, true);
  assert.ok(fs.existsSync(queuePath), 'queue file written to the userData directory');

  // ── Simulate a crash mid-upload: record persisted in `uploading` ────────
  const diskStore = new actualCore.PublishRecordStore(queuePath);
  diskStore.updateState(created.record.id, 'uploading', {
    resumableUploadUrl: 'http://127.0.0.1:9/upload_chunk/session_killed',
    bytesUploaded: 10,
    totalBytes: 45,
  });
  const rawOnDisk = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(rawOnDisk.find(r => r.id === created.record.id).state, 'uploading',
    'disk shows the record stuck in `uploading` (the kill state)');

  // ── "App restart": a NEW bridge instance over the same userData dir ─────
  // Startup reconciliation happens inside PublishRecordStore.load():
  const run2 = harness({ app: appMock });
  const listed = await run2.handlers.get('publisher:list-queue')(null, {});
  assert.equal(listed.ok, true);
  const recovered = listed.queue.find(r => r.id === created.record.id);
  assert.ok(recovered, 'queue survived the restart');
  assert.equal(recovered.state, 'queued',
    'record stuck in `uploading` on disk recovered to a resumable state at bridge startup');
  assert.ok(recovered.recoveredAt, 'recovery timestamp recorded');
  assert.equal(recovered.resumableUploadUrl, 'http://127.0.0.1:9/upload_chunk/session_killed');
  assert.equal(recovered.bytesUploaded, 10);
  assert.equal(recovered.error, null);

  // The recovered record can be re-queued via the existing retry IPC too
  // (idempotent: already `queued` after reconciliation).
  const retried = await run2.handlers.get('publisher:retry')(null, recovered.id);
  assert.equal(retried.ok, true);
  assert.equal(retried.record.state, 'queued');

  // Duplicate protection still holds after recovery (same hash + channel).
  const dup = await run2.handlers.get('publisher:create-session')(null, {
    channelId: 'UC_DURABILITY',
    videoPath: videoFile,
    metadata: { title: 'Duplicate after recovery' },
  });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /Duplicate publication blocked/);
});
