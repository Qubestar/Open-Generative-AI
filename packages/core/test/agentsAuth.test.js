import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KNOWN_AGENTS, parseGeminiAuthSettings } = require('../../../electron/lib/agents.js');

test('Gemini installation identity is never treated as authentication', () => {
  const gemini = KNOWN_AGENTS.find(agent => agent.id === 'gemini');
  assert(gemini);
  assert(!gemini.authPaths.includes('.gemini/installation_id'));
});

test('Gemini requires an explicit supported auth method', () => {
  const disconnected = { authed: false, subscriptionReady: null, subscriptionType: null, authType: null };
  assert.deepEqual(parseGeminiAuthSettings({}), disconnected);
  assert.deepEqual(parseGeminiAuthSettings('{broken'), disconnected);
  assert.deepEqual(parseGeminiAuthSettings({ security: { auth: { selectedType: 'unknown' } } }), disconnected);

  assert.deepEqual(
    parseGeminiAuthSettings({ security: { auth: { selectedType: 'oauth-personal' } } }),
    { authed: true, subscriptionReady: null, subscriptionType: null, authType: 'oauth-personal' },
  );
  assert.deepEqual(
    parseGeminiAuthSettings({ selectedAuthType: 'gemini-api-key' }),
    { authed: true, subscriptionReady: null, subscriptionType: null, authType: 'gemini-api-key' },
  );
});
