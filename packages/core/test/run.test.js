import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/jobs.js';
import { runJob } from '../src/run.js';
import { falAdapter } from '../src/adapters/fal.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const noSleep = () => Promise.resolve();

// Fake fetch simulating the fal queue: submit → IN_QUEUE → COMPLETED →
// response payload → media bytes.
function fakeFalFetch({ polls = 1, mediaUrl = 'https://cdn.fal.test/out.png' } = {}) {
  let statusCalls = 0;
  const calls = [];
  const json = (obj, ok = true, status = 200) => ({
    ok, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new TextEncoder().encode('PNGBYTES').buffer,
  });
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (String(url).includes('queue.fal.test') && opts.method === 'POST') {
      return json({
        request_id: 'r1',
        status_url: 'https://queue.fal.test/status/r1',
        response_url: 'https://queue.fal.test/response/r1',
      });
    }
    if (String(url).includes('/status/')) {
      statusCalls += 1;
      return json({ status: statusCalls <= polls ? 'IN_QUEUE' : 'COMPLETED' });
    }
    if (String(url).includes('/response/')) {
      return json({ images: [{ url: mediaUrl }] });
    }
    if (url === mediaUrl) return json({});
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const adapter = () => falAdapter({ model: 'fal-ai/flux/dev', key: 'k', queueBase: 'https://queue.fal.test' });

test('runJob drives a fal image job to done with the artifact on disk', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const outDir = tmp('vidmyo-out-');
  const job = store.create({ type: 'image', provider: 'fal', params: { prompt: 'a fox' } });

  const done = await runJob(store, job.id, adapter(), {
    outDir, fetchImpl: fakeFalFetch({ polls: 2 }), sleep: noSleep,
  });

  assert.equal(done.state, 'done');
  assert.equal(done.artifacts.length, 1);
  assert.ok(done.artifacts[0].path.endsWith(`${job.id}.png`));
  assert.equal(fs.readFileSync(done.artifacts[0].path, 'utf8'), 'PNGBYTES');
  assert.ok(done.checkpoints.handle.requestId === 'r1');
});

test('provider failure lands in error state with the message', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'fal', params: {} });
  const failing = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });

  const res = await runJob(store, job.id, adapter(), {
    outDir: tmp('vidmyo-out-'), fetchImpl: failing, sleep: noSleep,
  });
  assert.equal(res.state, 'error');
  assert.match(res.error, /fal submit failed: 500/);
});

test('cancellation between polls stops the run without error', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'fal', params: {} });
  const fetchImpl = fakeFalFetch({ polls: 50 });
  const cancellingSleep = () => { store.cancel(job.id); return Promise.resolve(); };

  const res = await runJob(store, job.id, adapter(), {
    outDir: tmp('vidmyo-out-'), fetchImpl, sleep: cancellingSleep,
  });
  assert.equal(res.state, 'cancelled');
  assert.equal(res.artifacts.length, 0);
});

test('resume skips submit when a handle is already checkpointed', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'fal', params: {} });
  store.setState(job.id, 'running');
  store.checkpoint(job.id, 'handle', {
    requestId: 'r1',
    statusUrl: 'https://queue.fal.test/status/r1',
    responseUrl: 'https://queue.fal.test/response/r1',
  });

  const fetchImpl = fakeFalFetch({ polls: 0 });
  const res = await runJob(store, job.id, adapter(), {
    outDir: tmp('vidmyo-out-'), fetchImpl, sleep: noSleep,
  });
  assert.equal(res.state, 'done');
  assert.ok(!fetchImpl.calls.some(c => c.method === 'POST'), 'no re-submit on resume');
});

test('timeout produces an error state, not a hang', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'fal', params: {} });
  const res = await runJob(store, job.id, adapter(), {
    outDir: tmp('vidmyo-out-'), fetchImpl: fakeFalFetch({ polls: 999 }), sleep: noSleep, maxPolls: 3,
  });
  assert.equal(res.state, 'error');
  assert.match(res.error, /Timed out after 3 polls/);
});
