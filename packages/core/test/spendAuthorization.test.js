import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSubmitProviderRequest } from '../../studio/src/spendAuthorization.mjs';

test('provider request needs one explicit approval and complete inputs', () => {
  const ready = { approved: true, busy: false, prompt: 'Create a calm pan', endpoint: 'fal/model' };
  assert.equal(canSubmitProviderRequest(ready), true);
  assert.equal(canSubmitProviderRequest({ ...ready, approved: false }), false);
  assert.equal(canSubmitProviderRequest({ ...ready, busy: true }), false);
  assert.equal(canSubmitProviderRequest({ ...ready, prompt: '   ' }), false);
  assert.equal(canSubmitProviderRequest({ ...ready, endpoint: '' }), false);
});

test('image-to-video authorization also requires a selected source', () => {
  const request = { approved: true, prompt: 'Move', endpoint: 'fal/model', requiresSource: true };
  assert.equal(canSubmitProviderRequest({ ...request, hasSource: false }), false);
  assert.equal(canSubmitProviderRequest({ ...request, hasSource: true }), true);
});
