import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PublishRecordStore,
  YouTubePublisherAdapter,
  createYouTubeResumableTransport,
  PUBLISH_STATES,
} from '../src/publisher.js';

test('PublishRecordStore blocks duplicate uploads to the same channel with same hash', () => {
  const store = new PublishRecordStore();

  const record1 = store.create({
    channelId: 'channel_yt_01',
    videoFileHash: 'hash_video_sample_12345',
    metadata: { title: 'First Upload #Shorts' },
  });
  assert.equal(record1.state, PUBLISH_STATES.QUEUED);
  assert.equal(record1.metadata.isShorts, true);

  // Attempting duplicate upload of same file hash to same channel must be blocked
  assert.throws(() => {
    store.create({
      channelId: 'channel_yt_01',
      videoFileHash: 'hash_video_sample_12345',
      metadata: { title: 'Accidental Duplicate' },
    });
  }, /Duplicate publication blocked/);

  // Different channel with same hash is permitted
  const record2 = store.create({
    channelId: 'channel_yt_02',
    videoFileHash: 'hash_video_sample_12345',
    metadata: { title: 'Second Channel' },
  });
  assert.ok(record2.id);
});

test('YouTubePublisherAdapter fails closed without an authenticated transport', async () => {
  const store = new PublishRecordStore();
  const adapter = new YouTubePublisherAdapter({ store }); // No transport provided

  const record = store.create({
    channelId: 'ch_test',
    videoFileHash: 'unique_hash_fail_closed',
    metadata: { title: 'Unconfigured Test' },
  });

  const dummyData = Buffer.from('video_bytes');
  await assert.rejects(async () => {
    await adapter.executeUploadSession(record.id, dummyData);
  }, /No publisher transport configured/);

  assert.equal(store.get(record.id).state, PUBLISH_STATES.ERROR);
});

test('createYouTubeResumableTransport executes real resumable protocol with 308 Resume Incomplete', async () => {
  const store = new PublishRecordStore();
  const totalBytes = 512 * 1024; // 512 KiB (2 chunks of 256 KiB)
  const dummyData = Buffer.alloc(totalBytes, 0x42);

  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url, method: options.method, headers: options.headers });

    if (options.method === 'POST') {
      // Step 1: Initiate Resumable Session
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) => (h.toLowerCase() === 'location' ? 'https://mock.upload.youtube/sessions/s123' : null),
        },
      };
    }

    if (options.method === 'PUT') {
      const contentRange = options.headers['Content-Range'];
      if (contentRange.startsWith('bytes 0-262143/')) {
        // Chunk 1 uploaded: server returns 308 Resume Incomplete
        return {
          ok: false,
          status: 308,
          headers: {
            get: (h) => (h.toLowerCase() === 'range' ? 'bytes=0-262143' : null),
          },
        };
      } else if (contentRange.startsWith('bytes 262144-524287/')) {
        // Chunk 2 uploaded: complete
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ id: 'yt_resumable_success_id_99' }),
        };
      }
    }

    throw new Error(`Unexpected mock request: ${options.method} ${url}`);
  };

  const transport = createYouTubeResumableTransport({
    getAccessToken: async () => 'mock_vault_token_abc',
    fetchImpl: mockFetch,
    chunkSize: 256 * 1024,
  });

  const adapter = new YouTubePublisherAdapter({ store, transport });

  const record = store.create({
    channelId: 'ch_test_resumable',
    videoFileHash: 'unique_hash_resumable_512k',
    metadata: { title: 'Resumable Test Video', privacyStatus: 'unlisted' },
  });

  const finished = await adapter.executeUploadSession(record.id, dummyData);

  assert.equal(finished.state, PUBLISH_STATES.PROCESSING);
  assert.equal(finished.remoteVideoId, 'yt_resumable_success_id_99');
  assert.equal(finished.bytesUploaded, totalBytes);
  assert.equal(requests.length, 3); // 1 POST (initiate) + 2 PUT (chunk 1 + chunk 2)
  assert.equal(requests[0].headers['Authorization'], 'Bearer mock_vault_token_abc');
});

test('createYouTubeResumableTransport maps 403 quota exhaustion automatically', async () => {
  const store = new PublishRecordStore();
  const dummyData = Buffer.from('data_for_quota_test');

  const mockFetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null },
    json: async () => ({
      error: { errors: [{ reason: 'quotaExceeded' }] }
    }),
  });

  const transport = createYouTubeResumableTransport({
    getAccessToken: async () => 'mock_token',
    fetchImpl: mockFetch,
  });

  const adapter = new YouTubePublisherAdapter({ store, transport });
  const record = store.create({
    channelId: 'ch_quota_test',
    videoFileHash: 'hash_quota_123',
    metadata: { title: 'Quota Test' },
  });

  const result = await adapter.executeUploadSession(record.id, dummyData);
  assert.equal(result.state, PUBLISH_STATES.QUEUED);
  assert.match(result.error, /quota exceeded/i);
});

test('createYouTubeResumableTransport refreshes an expired token on 401 and retries once', async () => {
  const store = new PublishRecordStore();
  const dummyData = Buffer.from('data_for_401_refresh_test');

  let tokenCalls = 0;
  let refreshCalls = 0;
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ method: options.method, headers: options.headers });
    if (options.headers['Authorization'] === 'Bearer stale_token') {
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { message: 'invalid credentials' } }) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'location' ? 'https://mock.upload.youtube/sessions/s401' : null) },
    };
  };

  const transport = createYouTubeResumableTransport({
    getAccessToken: async () => { tokenCalls += 1; return 'stale_token'; },
    refreshAccessToken: async () => { refreshCalls += 1; return 'fresh_token'; },
    fetchImpl: mockFetch,
  });

  const { uploadUrl } = await transport.initiateResumableUpload({ title: 'Refresh Test' });
  assert.equal(uploadUrl, 'https://mock.upload.youtube/sessions/s401');
  assert.equal(tokenCalls, 1, 'getAccessToken used for the first attempt');
  assert.equal(refreshCalls, 1, 'refreshAccessToken invoked exactly once after the 401');
  assert.equal(requests.length, 2, 'exactly one retry after refresh, not an infinite loop');
  assert.equal(requests[0].headers['Authorization'], 'Bearer stale_token');
  assert.equal(requests[1].headers['Authorization'], 'Bearer fresh_token');
});

test('createYouTubeResumableTransport surfaces a clear error if the token is still invalid after refresh', async () => {
  const mockFetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) });

  const transport = createYouTubeResumableTransport({
    getAccessToken: async () => 'stale_token',
    refreshAccessToken: async () => 'still_bad_token',
    fetchImpl: mockFetch,
  });

  await assert.rejects(
    transport.initiateResumableUpload({ title: 'Still Bad' }),
    /authentication failed after token refresh/,
  );
});

test('PublishRecordStore persists queue to disk and reloads on app restart', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-pub-persist-'));
  const queuePath = path.join(tmpDir, 'queue.json');

  const store1 = new PublishRecordStore(queuePath);
  const rec = store1.create({
    channelId: 'ch_restart_test',
    videoFileHash: 'hash_restart_123',
    metadata: { title: 'Persistent Video' },
  });
  store1.updateState(rec.id, PUBLISH_STATES.UPLOADING, {
    bytesUploaded: 500,
    totalBytes: 1000,
    resumableUploadUrl: 'http://127.0.0.1:9/upload_chunk/session_restart',
  });

  // Simulate app restart by instantiating new store on same file.
  // Startup reconciliation: a record left in the in-flight `uploading`
  // state by a crash/kill is recovered to a resumable `queued` state
  // (progress and session URL preserved) instead of staying stuck.
  const store2 = new PublishRecordStore(queuePath);
  const reloaded = store2.get(rec.id);
  assert.ok(reloaded);
  assert.equal(reloaded.state, PUBLISH_STATES.QUEUED, 'in-flight uploading record recovered at load');
  assert.ok(reloaded.recoveredAt, 'recovery timestamp recorded');
  assert.equal(reloaded.bytesUploaded, 500, 'upload progress preserved');
  assert.equal(reloaded.resumableUploadUrl, 'http://127.0.0.1:9/upload_chunk/session_restart', 'session URL preserved for resume');
  assert.equal(reloaded.error, null);

  const pending = store2.getPendingJobs();
  assert.equal(pending.length, 1, 'recovered record is pending again');
  assert.equal(pending[0].id, rec.id);

  // Recovery is persisted: another restart sees the recovered state.
  const store3 = new PublishRecordStore(queuePath);
  assert.equal(store3.get(rec.id).state, PUBLISH_STATES.QUEUED);

  // Test cancel and retry (Phase 2: cancel ends in terminal 'cancelled', not 'error')
  store2.cancel(rec.id);
  assert.equal(store2.get(rec.id).state, PUBLISH_STATES.CANCELLED);

  store2.retry(rec.id);
  assert.equal(store2.get(rec.id).state, PUBLISH_STATES.QUEUED);
});

test('PublishRecordStore retry re-queues a record stuck in uploading', () => {
  const store = new PublishRecordStore();
  const rec = store.create({
    channelId: 'ch_stuck_uploading',
    videoFileHash: 'hash_stuck_uploading',
    metadata: { title: 'Stuck Upload' },
  });
  store.updateState(rec.id, PUBLISH_STATES.UPLOADING, { bytesUploaded: 10, totalBytes: 45 });

  // No durable path (same-process stuck record): retry() must still work.
  const afterRetry = store.retry(rec.id);
  assert.equal(afterRetry.state, PUBLISH_STATES.QUEUED);
  assert.equal(afterRetry.error, null);
  assert.equal(store.getPendingJobs().length, 1);
});

test('YouTubePublisherAdapter polls remote processing and handles quota exhaustion', async () => {
  const store = new PublishRecordStore();
  const mockTransport = {
    async checkProcessingStatus(videoId) {
      return { processingStatus: 'succeeded' };
    },
  };
  const adapter = new YouTubePublisherAdapter({ store, transport: mockTransport });

  const rec = store.create({
    channelId: 'ch_poll',
    videoFileHash: 'hash_poll_999',
    metadata: { title: 'Poll Test' },
  });
  store.updateState(rec.id, PUBLISH_STATES.PROCESSING, { remoteVideoId: 'yt_poll_123' });

  // Poll transitions from PROCESSING to PUBLISHED
  const polled = await adapter.pollProcessingStatus(rec.id);
  assert.equal(polled.state, PUBLISH_STATES.PUBLISHED);

  // Test quota exhaustion
  adapter.handleQuotaExhaustion(rec.id, { quotaResetTime: 'midnight PT' });
  assert.equal(store.get(rec.id).state, PUBLISH_STATES.QUEUED);
  assert.match(store.get(rec.id).error, /quota exceeded/i);
});

test('createYouTubeResumableTransport queryUploadStatus handles 308 resume query and completion', async () => {
  let callCount = 0;
  const mockFetch = async (url, opts) => {
    callCount++;
    assert.equal(opts.method, 'PUT');
    assert.equal(opts.headers['Content-Range'], 'bytes */1000');
    assert.equal(opts.headers['Content-Length'], '0');

    if (callCount === 1) {
      return {
        status: 308,
        headers: new Headers({ Range: 'bytes=0-499' }),
      };
    }
    return {
      status: 200,
      json: async () => ({ id: 'yt_resumed_video_99' }),
    };
  };

  const transport = createYouTubeResumableTransport({
    getAccessToken: async () => 'test_token',
    fetchImpl: mockFetch,
  });

  const res1 = await transport.queryUploadStatus('http://upload.url', 1000);
  assert.equal(res1.bytesReceived, 500);
  assert.equal(res1.done, false);

  const res2 = await transport.queryUploadStatus('http://upload.url', 1000);
  assert.equal(res2.bytesReceived, 1000);
  assert.equal(res2.done, true);
  assert.equal(res2.videoId, 'yt_resumed_video_99');
});

test('YouTubePublisherAdapter duplicate protection skips upload if remoteVideoId is already present', async () => {
  const store = new PublishRecordStore();
  let uploadCalled = false;
  const mockTransport = {
    async initiateResumableUpload() { uploadCalled = true; return { uploadUrl: 'http://test' }; },
    async uploadChunk() { uploadCalled = true; return { done: true, videoId: 'yt_new' }; },
  };
  const adapter = new YouTubePublisherAdapter({ store, transport: mockTransport });

  const rec = store.create({
    channelId: 'ch_dup_guard',
    videoFileHash: 'hash_dup_guard_123',
    metadata: { title: 'Already Done' },
  });
  store.updateState(rec.id, PUBLISH_STATES.PUBLISHED, { remoteVideoId: 'yt_existing_video' });

  const result = await adapter.executeUploadSession(rec.id, Buffer.from('data'));
  assert.equal(result.remoteVideoId, 'yt_existing_video');
  assert.equal(uploadCalled, false, 'Transport upload must not be called when remoteVideoId already exists');
});


test('PublishRecordStore startup reconciliation: stuck processing recovered, pollable processing preserved', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-pub-recover-'));
  const queuePath = path.join(tmpDir, 'queue.json');

  // (a) `processing` WITHOUT remoteVideoId cannot be polled → recovered to
  // `queued` so it resumes through queryUploadStatus.
  const store1 = new PublishRecordStore(queuePath);
  const recA = store1.create({
    channelId: 'ch_processing_stuck',
    videoFileHash: 'hash_processing_stuck',
    metadata: { title: 'Stuck Processing' },
  });
  store1.updateState(recA.id, PUBLISH_STATES.PROCESSING, {
    resumableUploadUrl: 'http://127.0.0.1:9/upload_chunk/session_stuck',
    bytesUploaded: 45,
    totalBytes: 45,
  });

  // (b) `processing` WITH remoteVideoId is pollable → preserved.
  const recB = store1.create({
    channelId: 'ch_processing_ok',
    videoFileHash: 'hash_processing_ok',
    metadata: { title: 'Healthy Processing' },
  });
  store1.updateState(recB.id, PUBLISH_STATES.PROCESSING, {
    remoteVideoId: 'yt_remote_123',
    resumableUploadUrl: 'http://127.0.0.1:9/upload_chunk/session_ok',
    bytesUploaded: 45,
    totalBytes: 45,
  });

  const store2 = new PublishRecordStore(queuePath);
  const stuck = store2.get(recA.id);
  assert.equal(stuck.state, PUBLISH_STATES.QUEUED, 'unpollable processing record recovered');
  assert.ok(stuck.recoveredAt);
  assert.equal(stuck.bytesUploaded, 45);

  const healthy = store2.get(recB.id);
  assert.equal(healthy.state, PUBLISH_STATES.PROCESSING, 'pollable processing record preserved');
  assert.equal(healthy.remoteVideoId, 'yt_remote_123');
});
