import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationResumeReadiness } from '../src/generation.js';

test('generation resume only allows a never-submitted job or a saved provider handle', () => {
  const base = { type: 'video', checkpoints: { model: 'fal/model' } };
  assert.equal(generationResumeReadiness({ ...base, state: 'queued' }).safe, true);
  assert.equal(generationResumeReadiness({ ...base, state: 'running', checkpoints: { ...base.checkpoints, handle: { requestId: 'existing' } } }).safe, true);
  assert.equal(generationResumeReadiness({ ...base, state: 'error', checkpoints: { ...base.checkpoints, handle: { requestId: 'existing' } } }).safe, true);
  const uncertain = generationResumeReadiness({ ...base, state: 'running' });
  assert.equal(uncertain.safe, false);
  assert.match(uncertain.reason, /duplicate charge/i);
});

test('finished, invalid and model-less jobs do not resume', () => {
  assert.equal(generationResumeReadiness(null).safe, false);
  assert.equal(generationResumeReadiness({ type: 'story', state: 'queued', checkpoints: { model: 'x' } }).safe, false);
  assert.equal(generationResumeReadiness({ type: 'image', state: 'queued', checkpoints: {} }).safe, false);
  assert.equal(generationResumeReadiness({ type: 'image', state: 'done', checkpoints: { model: 'x' } }).safe, false);
});
