import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/jobs.js';
import { runJob } from '../src/run.js';
import { higgsfieldAdapter } from '../src/adapters/higgsfield.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const noSleep = () => Promise.resolve();

// Fake fetch simulating the real Higgsfield v2 wire format: submit → queued →
// completed → media bytes. No `/v2/` prefix, no `{params:...}` wrapper —
// verified against the shipped @higgsfield/client v0.2.1 source.
function fakeHiggsfieldFetch({ polls = 1, mediaUrl = 'https://cdn.higgsfield.test/out.png' } = {}) {
  let statusCalls = 0;
  const calls = [];
  const json = (obj, ok = true, status = 200) => ({
    ok, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new TextEncoder().encode('PNGBYTES').buffer,
  });
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers });
    if (String(url).endsWith('/flux-pro/kontext/max/text-to-image') && opts.method === 'POST') {
      assert.equal(JSON.parse(opts.body).prompt, 'a fox', 'body is flat input, not wrapped in params');
      return json({ status: 'queued', request_id: 'r1' });
    }
    if (String(url).includes('/requests/r1/status')) {
      statusCalls += 1;
      if (statusCalls <= polls) return json({ status: 'queued', request_id: 'r1' });
      return json({ status: 'completed', request_id: 'r1', images: [{ url: mediaUrl }] });
    }
    if (url === mediaUrl) return json({});
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const adapter = () => higgsfieldAdapter({ key: 'id:secret', base: 'https://platform.higgsfield.test' });

test('runJob drives a higgsfield image job to done with the artifact on disk', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const outDir = tmp('vidmyo-out-');
  const job = store.create({ type: 'image', provider: 'higgsfield', params: { prompt: 'a fox' } });

  const fetchImpl = fakeHiggsfieldFetch({ polls: 2 });
  const done = await runJob(store, job.id, adapter(), { outDir, fetchImpl, sleep: noSleep });

  assert.equal(done.state, 'done');
  assert.equal(done.artifacts.length, 1);
  assert.ok(done.artifacts[0].path.endsWith(`${job.id}.png`));
  assert.equal(fs.readFileSync(done.artifacts[0].path, 'utf8'), 'PNGBYTES');
  assert.equal(done.checkpoints.handle.id, 'r1');

  const submitCall = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.equal(submitCall.url, 'https://platform.higgsfield.test/flux-pro/kontext/max/text-to-image');
  assert.equal(submitCall.headers.Authorization, 'Key id:secret');
  const pollCall = fetchImpl.calls.find((c) => c.url.includes('/requests/'));
  assert.equal(pollCall.url, 'https://platform.higgsfield.test/requests/r1/status');
});

test('a 401 from Higgsfield lands in error state with the response body', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'higgsfield', params: { prompt: 'a fox' } });
  const failing = async () => ({
    ok: false, status: 401, text: async () => '{"detail":"Invalid credentials"}',
  });

  const res = await runJob(store, job.id, adapter(), {
    outDir: tmp('vidmyo-out-'), fetchImpl: failing, sleep: noSleep,
  });
  assert.equal(res.state, 'error');
  assert.match(res.error, /Higgsfield submit 401/);
  assert.match(res.error, /Invalid credentials/);
});
