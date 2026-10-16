import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  EntitlementValidationError,
  authorizeEntitlementCapability,
  entitlementStatus,
  evaluateEntitlement,
  verifySignedEntitlement,
} from '../index.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

function compact(claims, header = { alg: 'EdDSA', typ: 'VIDMYO-ENTITLEMENT' }) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), privateKey).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function claims(overrides = {}) {
  return {
    version: 1,
    accountId: 'account_123',
    deviceId: 'device_456',
    plan: 'creator',
    issuedAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-23T00:00:00.000Z',
    offlineGraceUntil: '2026-09-30T00:00:00.000Z',
    capabilities: ['story:create', 'team:claim'],
    ...overrides,
  };
}

test('verifies a strict Ed25519 public-key-only entitlement contract', () => {
  const verified = verifySignedEntitlement(compact(claims()), { publicKey });
  assert.deepEqual(verified, { ...claims(), status: 'active' });
  assert.throws(() => verifySignedEntitlement(compact(claims()), { publicKey: privateKey }), EntitlementValidationError);

  const wrong = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifySignedEntitlement(compact(claims()), { publicKey: wrong }), /signature/);
  assert.throws(() => verifySignedEntitlement(compact(claims({ capabilities: ['story:create', 'story:create'] })), { publicKey }), /duplicates/);
  assert.throws(() => verifySignedEntitlement(compact(claims({ prompt: 'never allowed' })), { publicKey }), /not allowed/);
  assert.throws(() => verifySignedEntitlement(compact(claims({ offlineGraceUntil: '2026-10-01T00:00:01.000Z' })), { publicKey }), /seven-day/);
});

test('fails protected capabilities closed while local unprotected projects stay readable', () => {
  const expired = claims();
  const at = '2026-10-01T00:00:00.000Z';
  assert.equal(entitlementStatus(expired, { now: at }), 'expired');
  assert.deepEqual(authorizeEntitlementCapability(expired, 'story:create', { now: at }), {
    allowed: false, reason: 'expired', status: 'expired',
  });
  assert.deepEqual(authorizeEntitlementCapability(expired, 'project:read', { protectedCapability: false, now: at }), {
    allowed: true, reason: 'local_unprotected', status: 'local',
  });
  assert.equal(evaluateEntitlement(expired, { now: at }).localProjectsReadable, true);
});

test('uses seven-day signed offline grace and treats server revocation as immediately protected-denied', () => {
  const duringGrace = '2026-09-28T12:00:00.000Z';
  assert.equal(entitlementStatus(claims(), { now: duringGrace }), 'offline_grace');
  assert.deepEqual(authorizeEntitlementCapability(claims(), 'story:create', { now: duringGrace }), {
    allowed: true, reason: 'offline_grace', status: 'offline_grace',
  });
  const revoked = claims({ status: 'revoked' });
  assert.equal(entitlementStatus(revoked, { now: '2026-09-22T12:00:00.000Z' }), 'revoked');
  assert.equal(authorizeEntitlementCapability(revoked, 'story:create').allowed, false);
});
