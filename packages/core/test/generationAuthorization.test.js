import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationAuthorizationStore, generationRequestFingerprint } from '../src/generationAuthorization.js';

const request = { kind: 'image', provider: 'fal', model: 'fal/model', params: { prompt: 'A lighthouse', size: '1024x1024' } };

test('generation fingerprint is stable across object key order', () => {
  assert.equal(generationRequestFingerprint(request), generationRequestFingerprint({
    provider: 'fal', params: { size: '1024x1024', prompt: 'A lighthouse' }, model: 'fal/model', kind: 'image',
  }));
});

test('provider approval is exact and can be consumed only once', () => {
  const store = new GenerationAuthorizationStore({ randomId: () => 'one-use' });
  const issued = store.issue(request);
  assert.equal(store.consume(issued.authorizationId, request), true);
  assert.throws(() => store.consume(issued.authorizationId, request), /Approve this provider request/);
});

test('changed settings consume and reject the old approval', () => {
  const store = new GenerationAuthorizationStore({ randomId: () => 'changed' });
  store.issue(request);
  assert.throws(() => store.consume('changed', { ...request, model: 'fal/other' }), /settings changed/);
  assert.throws(() => store.consume('changed', request), /Approve this provider request/);
});

test('expired provider approval is rejected', () => {
  let now = 1000;
  const store = new GenerationAuthorizationStore({ ttlMs: 50, now: () => now, randomId: () => 'expired' });
  store.issue(request);
  now = 1051;
  assert.throws(() => store.consume('expired', request), /expired/);
});
