import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../src/jobs.js';

const tmpStore = () => new JobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-jobs-')));

test('create → running → done lifecycle with logs and artifacts', () => {
  const store = tmpStore();
  const job = store.create({ type: 'image', provider: 'fal', params: { prompt: 'a fox' } });
  assert.match(job.id, /^job_\d+_[0-9a-f]{8}$/);
  assert.equal(job.state, 'queued');

  store.setState(job.id, 'running');
  store.log(job.id, 'submitted to fal queue');
  const artifact = path.join(store.dir, 'out.png');
  fs.writeFileSync(artifact, 'png');
  store.addArtifact(job.id, { path: artifact, kind: 'image' });
  const done = store.setState(job.id, 'done');

  assert.equal(done.state, 'done');
  assert.ok(done.startedAt && done.endedAt);
  assert.equal(done.logs.length, 1);
  assert.equal(done.artifacts[0].path, artifact);
});

test('records survive a new store instance (durability)', () => {
  const store = tmpStore();
  const job = store.create({ type: 'story', params: {} });
  store.checkpoint(job.id, 'lastCompletedScene', 's003');

  const reopened = new JobStore(store.dir);
  const loaded = reopened.get(job.id);
  assert.equal(loaded.checkpoints.lastCompletedScene, 's003');
  assert.equal(reopened.list({ type: 'story' }).length, 1);
});

test('illegal transitions are rejected', () => {
  const store = tmpStore();
  const job = store.create({ type: 'video' });
  assert.throws(() => store.setState(job.id, 'done'), /Illegal transition queued → done/);
  store.setState(job.id, 'running');
  store.setState(job.id, 'done');
  assert.throws(() => store.setState(job.id, 'running'), /Illegal transition done → running/);
});

test('cancel works from queued and running, not from done', () => {
  const store = tmpStore();
  const a = store.create({ type: 'image' });
  assert.equal(store.cancel(a.id).state, 'cancelled');

  const b = store.create({ type: 'image' });
  store.setState(b.id, 'running');
  assert.equal(store.cancel(b.id).state, 'cancelled');

  const c = store.create({ type: 'image' });
  store.setState(c.id, 'running');
  store.setState(c.id, 'done');
  assert.throws(() => store.cancel(c.id));
});

test('error state captures the message', () => {
  const store = tmpStore();
  const job = store.create({ type: 'video' });
  store.setState(job.id, 'running');
  const failed = store.setState(job.id, 'error', { error: 'provider quota exceeded' });
  assert.equal(failed.error, 'provider quota exceeded');
});

test('list filters by state and sorts newest first', () => {
  const store = tmpStore();
  const j1 = store.create({ type: 'image' });
  store.create({ type: 'image' });
  store.cancel(j1.id);
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ state: 'queued' }).length, 1);
  assert.equal(store.list({ state: 'cancelled' })[0].id, j1.id);
});

test('invalid job ids never reach the filesystem', () => {
  const store = tmpStore();
  // Reads resolve to null (get() treats unreadable as missing)…
  assert.equal(store.get('../../etc/passwd'), null);
  // …and every mutating path refuses before any write happens.
  assert.throws(() => store.log('../../etc/passwd', 'x'), /No such job/);
  assert.throws(() => store.setState('job_$(rm -rf)', 'running'), /No such job|Invalid job id/);
});
