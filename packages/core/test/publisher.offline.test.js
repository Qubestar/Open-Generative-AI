// Phase 2 Item 4 — Persistent publish queue, OFFLINE ONLY.
//
// All tests run against a loopback mock that speaks the real resumable
// protocol (Content-Range / 308). No real YouTube call is ever made — every
// transport gets baseUrl = 127.0.0.1 and a fetch wrapper asserts the host.
//
// Covers:
//   1. multi-chunk upload with Content-Range + 308 Resume Incomplete
//   2. durable queue survives an app restart and resumes via
//      queryUploadStatus without re-initiating (no duplicate POST)
//   3. cancel aborts the in-flight HTTP request and ends in `cancelled`
//   4. quota errors map to the existing quota handling (queued + message)
//   5. token refresh goes through an injected provider (vault stand-in)
//   6. production transport stays disabled and fails closed
//   7. process KILL while the record is in `uploading`: startup
//      reconciliation recovers it to a resumable `queued` state and the
//      upload resumes via queryUploadStatus (no duplicate initiate)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PublishRecordStore,
  YouTubePublisherAdapter,
  createYouTubeResumableTransport,
  createLoopbackResumableMockServer,
  PUBLISH_STATES,
} from '../index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// Wraps global fetch: data-chunk PUTs can be made to fail after N successes
// (simulates a mid-upload network drop), and every URL is asserted to stay
// on the loopback host (no real YouTube call possible).
function makeGuardedFetch({ baseUrl, failDataChunkAfter = Infinity } = {}) {
  let dataChunks = 0;
  return async (url, options = {}) => {
    const host = new URL(String(url)).hostname;
    assert.ok(host === '127.0.0.1' || host === 'localhost',
      `offline test attempted non-loopback fetch: ${url}`);
    if (baseUrl) assert.ok(String(url).startsWith(baseUrl), `expected baseUrl prefix: ${url}`);
    const contentRange = options.headers?.['Content-Range'] || '';
    const isDataChunk = options.method === 'PUT' && /^bytes \d+-/.test(contentRange);
    if (isDataChunk) {
      dataChunks += 1;
      if (dataChunks > failDataChunkAfter) {
        throw new TypeError('simulated network failure mid-upload');
      }
    }
    return fetch(url, options);
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withMock(fn) {
  const mock = createLoopbackResumableMockServer();
  const { baseUrl } = await mock.start();
  try {
    return await fn(mock, baseUrl);
  } finally {
    await mock.stop();
  }
}

function makeStore(queuePath) {
  return new PublishRecordStore(queuePath);
}

function makeRecord(store, salt = 'a') {
  return store.create({
    channelId: `ch_offline_${salt}`,
    videoFileHash: `hash_offline_${salt}_${Date.now()}`,
    videoPath: '/tmp/unused-by-buffer.mp4',
    metadata: { title: `Offline ${salt}`, privacyStatus: 'private' },
  });
}

// ---------------------------------------------------------------------------
// 1. Multi-chunk resumable upload: Content-Range headers + 308 handling
// ---------------------------------------------------------------------------
test('offline: multi-chunk upload sends sequential Content-Range and handles 308 until complete', async () => {
  await withMock(async (mock, baseUrl) => {
    const store = makeStore(path.join(tempDir('vidmyo-q1-'), 'queue.json'));
    const record = makeRecord(store, 'multi');
    const transport = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter = new YouTubePublisherAdapter({ store, transport });

    const payload = Buffer.alloc(45, 0x41);
    const final = await adapter.executeUploadSession(record.id, payload);

    assert.equal(final.state, PUBLISH_STATES.PROCESSING);
    assert.match(final.remoteVideoId, /^yt_http_/);
    assert.equal(final.bytesUploaded, 45);
    assert.equal(final.totalBytes, 45);

    assert.equal(mock.stats.initiates, 1, 'exactly one resumable session initiated');
    assert.deepEqual(mock.stats.contentRanges, [
      'bytes 0-9/45',
      'bytes 10-19/45',
      'bytes 20-29/45',
      'bytes 30-39/45',
      'bytes 40-44/45',
    ]);
    assert.equal(mock.getUploadedVideos()[0].size, 45);
  });
});

// ---------------------------------------------------------------------------
// 2. Durable queue survives restart; resume via queryUploadStatus, no re-POST
// ---------------------------------------------------------------------------
test('offline: queue survives restart and resumes from bytesUploaded without duplicate initiate', async () => {
  await withMock(async (mock, baseUrl) => {
    const queuePath = path.join(tempDir('vidmyo-q2-'), 'queue.json');

    // ── Run 1: network drops on the 2nd data chunk ──────────────────────────
    const store1 = makeStore(queuePath);
    const record = makeRecord(store1, 'resume');
    const transport1 = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl, failDataChunkAfter: 1 }),
    });
    const adapter1 = new YouTubePublisherAdapter({ store: store1, transport: transport1 });
    const payload = Buffer.alloc(45, 0x42);

    await assert.rejects(
      adapter1.executeUploadSession(record.id, payload),
      /simulated network failure/,
    );

    const crashed = store1.get(record.id);
    assert.equal(crashed.state, PUBLISH_STATES.ERROR);
    assert.ok(crashed.resumableUploadUrl, 'resumable session URL persisted');
    assert.equal(crashed.bytesUploaded, 10, 'first chunk progress persisted');
    assert.equal(mock.stats.initiates, 1);

    // ── "App restart": fresh store instance from the same durable file ─────
    const store2 = makeStore(queuePath);
    const reloaded = store2.get(record.id);
    assert.ok(reloaded, 'record survived restart');
    assert.equal(reloaded.resumableUploadUrl, crashed.resumableUploadUrl);
    assert.equal(reloaded.bytesUploaded, 10);
    assert.equal(store2.getPendingJobs().length, 0, 'error is not pending');

    store2.retry(record.id);
    assert.equal(store2.get(record.id).state, PUBLISH_STATES.QUEUED);
    assert.equal(store2.getPendingJobs().length, 1, 'retry re-queues durably');

    // ── Run 2: healthy network — resumes via status query ──────────────────
    const transport2 = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter2 = new YouTubePublisherAdapter({ store: store2, transport: transport2 });
    const final = await adapter2.executeUploadSession(record.id, payload);

    assert.equal(final.state, PUBLISH_STATES.PROCESSING);
    assert.match(final.remoteVideoId, /^yt_http_/);

    // No duplicate initiate: session was reused across the "restart".
    assert.equal(mock.stats.initiates, 1, 'resume must NOT re-POST the initiate request');
    assert.ok(mock.stats.statusQueries >= 1, 'resume must query upload status first');
    // Byte ranges are contiguous with no re-send of the completed first chunk.
    assert.equal(mock.stats.contentRanges[0], 'bytes 0-9/45');
    assert.equal(mock.stats.contentRanges[1], 'bytes 10-19/45');
    const received = mock.getUploadedVideos()[0];
    assert.equal(received.size, 45);
  });
});

// ---------------------------------------------------------------------------
// 3. Cancel aborts the in-flight request and ends in `cancelled`
// ---------------------------------------------------------------------------
test('offline: cancel aborts the in-flight HTTP request and record ends in cancelled', async () => {
  await withMock(async (mock, baseUrl) => {
    const store = makeStore(path.join(tempDir('vidmyo-q3-'), 'queue.json'));
    const record = makeRecord(store, 'cancel');
    mock.control.stallNextChunk = true; // hold the first chunk PUT open

    const transport = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter = new YouTubePublisherAdapter({ store, transport });
    const payload = Buffer.alloc(45, 0x43);

    const run = adapter.executeUploadSession(record.id, payload);
    const stalled = await waitFor(() => mock.stats.stalledPending === 1);
    assert.ok(stalled, 'server must be holding the chunk request open');

    const didCancel = adapter.cancelUpload(record.id);
    assert.equal(didCancel, true, 'cancel transitions the record');

    const final = await run;
    assert.equal(final.state, PUBLISH_STATES.CANCELLED, 'record ends in cancelled, not error');
    assert.equal(final.error, null, 'cancelled is not an error');
    // The socket close on the server side is observed asynchronously after
    // the client abort — wait for it rather than racing the event loop.
    const sawAbort = await waitFor(() => mock.stats.abortedWhileStalled >= 1);
    assert.ok(sawAbort, 'the in-flight request must be aborted at the transport level');

    // Durable: a new store instance still sees the terminal state.
    const reloaded = makeStore(store.persistPath).get(record.id);
    assert.equal(reloaded.state, PUBLISH_STATES.CANCELLED);

    // And retry from cancelled re-queues the record.
    store.retry(record.id);
    assert.equal(store.get(record.id).state, PUBLISH_STATES.QUEUED);
  });
});

// ---------------------------------------------------------------------------
// 4. Quota errors map to the existing quota handling
// ---------------------------------------------------------------------------
test('offline: 403 quotaExceeded maps to the existing quota handling (queued + message)', async () => {
  await withMock(async (mock, baseUrl) => {
    const store = makeStore(path.join(tempDir('vidmyo-q4-'), 'queue.json'));
    const record = makeRecord(store, 'quota');
    mock.control.quotaOnNextChunk = true;

    const transport = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter = new YouTubePublisherAdapter({ store, transport });
    const payload = Buffer.alloc(45, 0x44);

    const final = await adapter.executeUploadSession(record.id, payload);
    assert.equal(final.state, PUBLISH_STATES.QUEUED, 'quota exhaustion re-queues, does not error');
    assert.match(final.error, /quota exceeded/i);
    assert.equal(final.remoteVideoId, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Token refresh via an injected provider (main-process vault stand-in)
// ---------------------------------------------------------------------------
test('offline: 401 triggers the injected refresh provider exactly once, then succeeds', async () => {
  await withMock(async (mock, baseUrl) => {
    mock.control.rejectTokens.add('stale-token');

    const store = makeStore(path.join(tempDir('vidmyo-q5-'), 'queue.json'));
    const record = makeRecord(store, 'refresh');

    let token = 'stale-token';
    let refreshCalls = 0;
    const transport = createYouTubeResumableTransport({
      getAccessToken: async () => token,
      refreshAccessToken: async () => {
        refreshCalls += 1;
        token = 'fresh-token';
        return token;
      },
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter = new YouTubePublisherAdapter({ store, transport });
    const payload = Buffer.alloc(25, 0x45);

    const final = await adapter.executeUploadSession(record.id, payload);

    assert.equal(final.state, PUBLISH_STATES.PROCESSING);
    assert.equal(refreshCalls, 1, 'refresh provider called exactly once');
    assert.equal(mock.stats.unauthorized, 1, 'exactly one 401 before refresh');
    assert.equal(mock.stats.initiates, 1, 'initiate retried on the same session flow, not duplicated after success');
  });
});

// ---------------------------------------------------------------------------
// 6. Production transport stays disabled and fails closed
// ---------------------------------------------------------------------------
test('offline: production transport fails closed and requires an injected token provider', () => {
  assert.throws(
    () => createYouTubeResumableTransport({}),
    /getAccessToken function is required/,
    'transport refuses to build without an explicit token provider',
  );

  // Adapter without a transport must fail closed and mark the record error.
  const store = makeStore(path.join(tempDir('vidmyo-q6-'), 'queue.json'));
  const record = makeRecord(store, 'failclosed');
  const adapter = new YouTubePublisherAdapter({ store }); // no transport
  return assert.rejects(
    adapter.executeUploadSession(record.id, Buffer.from('bytes')),
    /No publisher transport configured/,
  ).then(() => {
    assert.equal(store.get(record.id).state, PUBLISH_STATES.ERROR);
    assert.match(store.get(record.id).error, /No publisher transport configured/);
  });
});

// ---------------------------------------------------------------------------
// 7. Process kill while the record is in `uploading` → recovered at load
// ---------------------------------------------------------------------------
test('offline: process kill mid-upload leaves `uploading` on disk; store load recovers it and resumes without duplicate initiate', async () => {
  await withMock(async (mock, baseUrl) => {
    const queuePath = path.join(tempDir('vidmyo-q7-'), 'queue.json');

    // ── Run 1: upload starts, chunk 1 lands, chunk 2 hangs forever ─────────
    const store1 = makeStore(queuePath);
    const record = makeRecord(store1, 'kill');

    let dataChunks = 0;
    const hangingFetch = async (url, options = {}) => {
      const host = new URL(String(url)).hostname;
      assert.ok(host === '127.0.0.1' || host === 'localhost',
        `offline test attempted non-loopback fetch: ${url}`);
      const contentRange = options.headers?.['Content-Range'] || '';
      const isDataChunk = options.method === 'PUT' && /^bytes \d+-/.test(contentRange);
      if (isDataChunk) {
        dataChunks += 1;
        if (dataChunks >= 2) {
          // The process is "killed" here: this request never returns, so the
          // adapter never writes an `error` state — exactly what a crash or
          // SIGKILL mid-upload leaves behind on disk.
          return new Promise(() => {});
        }
      }
      return fetch(url, options);
    };

    const transport1 = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: hangingFetch,
    });
    const adapter1 = new YouTubePublisherAdapter({ store: store1, transport: transport1 });
    const payload = Buffer.alloc(45, 0x46);
    void adapter1.executeUploadSession(record.id, payload); // deliberately not awaited (hangs)

    // Wait until the durable file shows chunk 1 persisted in state `uploading`.
    const persisted = () => {
      const arr = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      return arr.find(r => r.id === record.id);
    };
    const sawUploading = await waitFor(() => {
      const r = (() => { try { return persisted(); } catch { return null; } })();
      return r && r.state === 'uploading' && r.bytesUploaded === 10 && Boolean(r.resumableUploadUrl);
    });
    assert.ok(sawUploading, 'disk must show the record stuck in `uploading` with session URL + progress');
    const crashed = persisted();
    assert.equal(crashed.state, 'uploading');

    // ── Kill: the old process can no longer write to the queue file ───────
    store1.persistPath = null;

    // ── "App restart": fresh store instance → startup reconciliation ──────
    const store2 = makeStore(queuePath);
    const recovered = store2.get(record.id);
    assert.ok(recovered, 'record survived the kill');
    assert.equal(recovered.state, PUBLISH_STATES.QUEUED,
      'record in `uploading` on disk is recovered to a resumable state at load');
    assert.ok(recovered.recoveredAt, 'recovery timestamp recorded');
    assert.equal(recovered.resumableUploadUrl, crashed.resumableUploadUrl, 'session URL preserved');
    assert.equal(recovered.bytesUploaded, 10, 'byte progress preserved');
    assert.equal(recovered.error, null, 'a kill is not a user-facing error');
    assert.equal(store2.getPendingJobs().length, 1, 'recovered record is pending');

    // ── Resume: queryUploadStatus first, no duplicate initiate ────────────
    const transport2 = createYouTubeResumableTransport({
      getAccessToken: async () => 'offline_token',
      baseUrl,
      chunkSize: 10,
      fetchImpl: makeGuardedFetch({ baseUrl }),
    });
    const adapter2 = new YouTubePublisherAdapter({ store: store2, transport: transport2 });
    const final = await adapter2.executeUploadSession(record.id, payload);

    assert.equal(final.state, PUBLISH_STATES.PROCESSING, 'recovered upload completes');
    assert.match(final.remoteVideoId, /^yt_http_/);
    assert.equal(mock.stats.initiates, 1, 'resume must NOT re-POST the initiate request');
    assert.ok(mock.stats.statusQueries >= 1, 'resume must query upload status first');
    assert.equal(mock.stats.contentRanges[0], 'bytes 0-9/45', 'chunk 1 not re-sent');
    assert.equal(mock.stats.contentRanges[1], 'bytes 10-19/45', 'upload continues from persisted progress');
    assert.equal(mock.getUploadedVideos()[0].size, 45);

    // Recovery survives yet another restart.
    const store3 = makeStore(queuePath);
    assert.equal(store3.get(record.id).state, PUBLISH_STATES.PROCESSING);
  });
});
