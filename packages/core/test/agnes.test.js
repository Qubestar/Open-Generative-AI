import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/jobs.js';
import { runJob } from '../src/run.js';
import { agnesAdapter } from '../src/adapters/agnes.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const noSleep = () => Promise.resolve();

function json(obj, ok = true, status = 200) {
  return {
    ok, status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => new TextEncoder().encode('BYTES').buffer,
  };
}

const imageAdapter = () => agnesAdapter({ key: 'k', model: 'agnes-image-2.0-flash', kind: 'image', base: 'https://agnes.test/v1' });
const videoAdapter = () => agnesAdapter({ key: 'k', model: 'agnes-video-v2.0', kind: 'video', base: 'https://agnes.test/v1', pollBase: 'https://agnes.test' });

test('runJob drives an Agnes image job to done in one synchronous call', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const outDir = tmp('vidmyo-out-');
  const job = store.create({ type: 'image', provider: 'agnes', params: { prompt: 'a fox', size: '1024x768' } });

  const mediaUrl = 'https://cdn.agnes.test/out.png';
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
    if (String(url) === 'https://agnes.test/v1/images/generations' && opts.method === 'POST') {
      return json({ created: 1, data: [{ url: mediaUrl, b64_json: null }] });
    }
    if (url === mediaUrl) return json({});
    throw new Error(`unexpected fetch: ${url}`);
  };

  const done = await runJob(store, job.id, imageAdapter(), { outDir, fetchImpl, sleep: noSleep });

  assert.equal(done.state, 'done');
  assert.equal(done.artifacts.length, 1);
  assert.ok(done.artifacts[0].path.endsWith(`${job.id}.png`));
  assert.equal(fs.readFileSync(done.artifacts[0].path, 'utf8'), 'BYTES');
  // Only one POST — no separate poll call for the synchronous image path.
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('runJob drives an Agnes video job through queued -> completed polling', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const outDir = tmp('vidmyo-out-');
  const job = store.create({ type: 'video', provider: 'agnes', params: { prompt: 'a fox', width: 1280, height: 720 } });

  const mediaUrl = 'https://cdn.agnes.test/out.mp4';
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url) === 'https://agnes.test/v1/videos' && opts.method === 'POST') {
      return json({ id: 'task_1', video_id: 'video_1', status: 'queued' });
    }
    if (String(url) === 'https://agnes.test/agnesapi?video_id=video_1') {
      polls += 1;
      if (polls < 2) return json({ status: 'in_progress', progress: 40 });
      return json({ status: 'completed', progress: 100, url: mediaUrl });
    }
    if (url === mediaUrl) return json({});
    throw new Error(`unexpected fetch: ${url}`);
  };

  const done = await runJob(store, job.id, videoAdapter(), { outDir, fetchImpl, sleep: noSleep });

  assert.equal(done.state, 'done');
  assert.equal(done.artifacts.length, 1);
  assert.ok(done.artifacts[0].path.endsWith(`${job.id}.mp4`));
  assert.equal(done.checkpoints.handle.videoId, 'video_1');
});

test('a 429 on the video status query keeps waiting instead of killing the render', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const outDir = tmp('vidmyo-out-');
  const job = store.create({ type: 'video', provider: 'agnes', params: { prompt: 'a fox' } });

  const mediaUrl = 'https://cdn.agnes.test/out.mp4';
  let polls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') return json({ video_id: 'video_1', status: 'queued' });
    if (String(url).includes('/agnesapi?video_id=video_1')) {
      polls += 1;
      // Agnes throttles video status queries; the render is still running.
      if (polls === 1) return json({ error: { code: 429, message: 'video status query rate limit exceeded' } }, false, 429);
      if (polls === 2) return json({ error: 'service overloaded' }, false, 503);
      return json({ status: 'completed', url: mediaUrl });
    }
    if (url === mediaUrl) return json({});
    throw new Error(`unexpected fetch: ${url}`);
  };

  const done = await runJob(store, job.id, videoAdapter(), { outDir, fetchImpl, sleep: noSleep });

  assert.equal(done.state, 'done', `expected the throttled job to survive, got: ${done.error}`);
  assert.equal(done.artifacts.length, 1);
  assert.equal(polls, 3);  // 429 -> 503 -> completed, all polled through
});

test('the video adapter polls within the free tier\'s 1 effective RPM; the sync image path needs no interval', () => {
  assert.ok(videoAdapter().pollMs >= 60000, 'faster than 1/min would throttle on the free tier');
  assert.equal(imageAdapter().pollMs, undefined);
});

test('a failed Agnes video job lands in error state', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'video', provider: 'agnes', params: { prompt: 'a fox' } });
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') return json({ video_id: 'video_1', status: 'queued' });
    return json({ status: 'failed' });
  };

  const res = await runJob(store, job.id, videoAdapter(), { outDir: tmp('vidmyo-out-'), fetchImpl, sleep: noSleep });
  assert.equal(res.state, 'error');
  assert.match(res.error, /failed/);
});

test('a 401 from Agnes image submit lands in error state with the response body', async () => {
  const store = new JobStore(tmp('vidmyo-run-'));
  const job = store.create({ type: 'image', provider: 'agnes', params: { prompt: 'a fox' } });
  const failing = async () => json({ detail: 'Invalid API key' }, false, 401);

  const res = await runJob(store, job.id, imageAdapter(), { outDir: tmp('vidmyo-out-'), fetchImpl: failing, sleep: noSleep });
  assert.equal(res.state, 'error');
  assert.match(res.error, /Agnes image submit 401/);
  assert.match(res.error, /Invalid API key/);
});
