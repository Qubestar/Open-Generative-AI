import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, PROVIDER_CATEGORIES, DEFAULT_PROVIDER,
  getProviderById, getProvidersForStudio, getProvidersByCategory,
  buildProviderHeaders, appendProviderAuthToUrl, buildProviderUrl,
} from '../src/providers.js';

test('catalog is the merged superset: openrouter, fal, and muapi all present', () => {
  const ids = PROVIDERS.map(p => p.id);
  for (const id of ['openrouter', 'fal', 'muapi', 'openai', 'google', 'claude_code', 'hermes']) {
    assert.ok(ids.includes(id), `missing provider: ${id}`);
  }
});

test('provider ids are unique', () => {
  const ids = PROVIDERS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every provider belongs to a declared category', () => {
  const cats = new Set(PROVIDER_CATEGORIES.map(c => c.id));
  for (const p of PROVIDERS) assert.ok(cats.has(p.category), `${p.id} has unknown category ${p.category}`);
});

test('default provider is openrouter and is the fallback for unknown ids', () => {
  assert.equal(DEFAULT_PROVIDER, 'openrouter');
  assert.equal(PROVIDERS[0].id, 'openrouter');
  assert.equal(getProviderById('does-not-exist').id, 'openrouter');
});

test('studio filtering includes muapi for image and video', () => {
  const image = getProvidersForStudio('image').map(p => p.id);
  assert.ok(image.includes('muapi'));
  assert.ok(image.includes('openrouter'));
  const video = getProvidersForStudio('video').map(p => p.id);
  assert.ok(video.includes('muapi'));
  assert.ok(video.includes('fal'));
});

test('agnes is registered for both image and video studios', () => {
  const agnes = getProviderById('agnes');
  assert.equal(agnes.category, 'aggregator');
  assert.equal(agnes.authHeader, 'Authorization');
  assert.equal(agnes.authPrefix, 'Bearer ');
  const image = getProvidersForStudio('image').map(p => p.id);
  const video = getProvidersForStudio('video').map(p => p.id);
  assert.ok(image.includes('agnes'));
  assert.ok(video.includes('agnes'));
});

test('integration category lists the five agents', () => {
  const agents = getProvidersByCategory('integration').map(p => p.id);
  assert.deepEqual(agents.sort(), ['claude_code', 'codex', 'gemini', 'hermes', 'opencode']);
});

test('headers are pure: explicit key only, correct prefix per provider', () => {
  const or = getProviderById('openrouter');
  assert.deepEqual(buildProviderHeaders(or, 'k1'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer k1',
  });
  const mu = getProviderById('muapi');
  assert.deepEqual(buildProviderHeaders(mu, 'k2'), {
    'Content-Type': 'application/json',
    'x-api-key': 'k2',
  });
  assert.deepEqual(buildProviderHeaders(or, ''), { 'Content-Type': 'application/json' });
});

test('query auth only applies to authInQuery providers', () => {
  const google = getProviderById('google');
  assert.equal(
    appendProviderAuthToUrl(google, 'https://x.test/a', 'g1'),
    'https://x.test/a?key=g1',
  );
  const or = getProviderById('openrouter');
  assert.equal(appendProviderAuthToUrl(or, 'https://x.test/a', 'k'), 'https://x.test/a');
});

test('buildProviderUrl normalizes slashes', () => {
  const or = getProviderById('openrouter');
  assert.equal(buildProviderUrl(or, '/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
});
