import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ACCESS_TOKEN_KEY, CACHE_KEY, DAY_MS, createEntitlementService } = require('../../../electron/lib/entitlementService.js');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

function signed(overrides = {}) {
  const claims = {
    version: 1, accountId: 'account_123', deviceId: 'device_456', plan: 'creator',
    issuedAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-23T00:00:00.000Z',
    offlineGraceUntil: '2026-09-30T00:00:00.000Z', capabilities: ['story:create', 'team:claim'], ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'VIDMYO-ENTITLEMENT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async key => values.get(key) || '',
    set: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function service(options = {}) {
  return createEntitlementService({
    secureStore: options.secureStore || store({ [ACCESS_TOKEN_KEY]: 'access-token' }),
    publicKey,
    serviceUrl: 'https://license.vidmyo.test/control',
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    fetch: options.fetch || (async () => response(200, { entitlement: signed() })),
    core: () => import('../index.js'),
    ...options,
  });
}

test('silently refreshes only against the configured HTTPS Vidmyo service and persists the signed cache', async () => {
  const calls = [];
  const encrypted = store({ [ACCESS_TOKEN_KEY]: 'access-token' });
  const client = service({ secureStore: encrypted, fetch: async (url, options) => {
    calls.push({ url, options });
    return response(200, { entitlement: signed() });
  } });
  const result = await client.refresh();
  assert.equal(result.ok, true);
  assert.equal(result.source, 'network');
  assert.equal(result.status, 'offline_grace');
  assert.equal(calls[0].url, 'https://license.vidmyo.test/control/v1/desktop/entitlements/refresh');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.headers.authorization, 'Bearer access-token');
  assert.ok(encrypted.values.get(CACHE_KEY).includes('ey'));
  assert.doesNotMatch(calls[0].options.body, /prompt|project|media|pipeline/i);
});

test('uses only the last valid signed entitlement during a network outage, then fails closed outside grace', async () => {
  const encrypted = store({
    [ACCESS_TOKEN_KEY]: 'access-token',
    [CACHE_KEY]: JSON.stringify({ compact: signed() }),
  });
  const client = service({ secureStore: encrypted, fetch: async () => { throw new Error('offline'); } });
  const cached = await client.refresh();
  assert.deepEqual({ ok: cached.ok, source: cached.source, status: cached.status }, { ok: true, source: 'cached', status: 'offline_grace' });

  const expiredClient = service({
    secureStore: encrypted,
    now: () => new Date('2026-10-02T00:00:00.000Z'),
    fetch: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(await expiredClient.refresh(), {
    ok: false, code: 'entitlement_expired', status: 'expired', localProjectsReadable: true,
  });
});

test('does not mask a revocation or authentication response with cached access', async () => {
  const encrypted = store({ [ACCESS_TOKEN_KEY]: 'access-token', [CACHE_KEY]: JSON.stringify({ compact: signed() }) });
  const client = service({ secureStore: encrypted, fetch: async () => response(403, { error: 'revoked-account-secret' }) });
  assert.deepEqual(await client.refresh(), { ok: false, code: 'authentication_required', localProjectsReadable: true });

  const revoked = service({ fetch: async () => response(200, { entitlement: signed({ status: 'revoked' }) }) });
  assert.deepEqual(await revoked.refresh(), {
    ok: false, code: 'entitlement_expired', status: 'revoked', localProjectsReadable: true,
  });
});

test('uses fixed compare-and-set team-claim endpoints with lease and idempotency metadata only', async () => {
  const calls = [];
  const client = service({ fetch: async (url, options) => {
    calls.push({ url, options });
    return response(200, { claim: {
      itemId: 'video_001', revision: 8, leaseId: 'lease_abc', expiresAt: '2026-09-22T13:00:00.000Z',
      prompt: 'must be discarded', pipeline: { internal: true },
    } });
  } });
  const request = { itemId: 'video_001', expectedRevision: 7, leaseMs: 3_600_000, idempotencyKey: 'request_123456789' };
  assert.deepEqual(await client.claimTeamWork(request), {
    ok: true, claim: { itemId: 'video_001', revision: 8, leaseId: 'lease_abc', expiresAt: '2026-09-22T13:00:00.000Z' },
  });
  assert.equal(calls[0].url, 'https://license.vidmyo.test/control/v1/team/claims/acquire');
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  await assert.rejects(client.claimTeamWork({ ...request, url: 'https://attacker.test/' }), /Unsupported/);
  const conflict = service({ fetch: async () => response(409, {}) });
  assert.deepEqual(await conflict.claimTeamWork(request), { ok: false, code: 'claim_conflict' });
});

test('starts one daily silent scheduler and can stop it', async () => {
  const schedules = [];
  const client = service({
    fetch: async () => response(200, { entitlement: signed() }),
    setInterval: (fn, delay) => { schedules.push({ fn, delay }); return { timer: 1 }; },
    clearInterval: timer => { schedules.push({ cleared: timer }); },
  });
  client.start();
  client.start();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].delay, DAY_MS);
  client.stop();
  assert.equal(schedules.length, 2);
});
