// Signed, local-first subscription entitlement contract.
//
// This module only verifies a compact Ed25519 JWS with a public key. It never
// signs claims and therefore never needs, accepts, or embeds a service secret.

import crypto from 'node:crypto';

const CLAIM_KEYS = Object.freeze([
  'version', 'accountId', 'deviceId', 'plan', 'issuedAt', 'expiresAt',
  'offlineGraceUntil', 'capabilities', 'status',
]);
const HEADER_KEYS = Object.freeze(['alg', 'typ', 'kid']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PLAN_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9:.-]{0,95}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_COMPACT_BYTES = 16 * 1024;
export const MAX_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export class EntitlementValidationError extends Error {
  constructor(message = 'Invalid signed entitlement.') {
    super(message);
    this.name = 'EntitlementValidationError';
  }
}

function fail(message) { throw new EntitlementValidationError(message); }

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}.${key} is not allowed.`);
}

function string(value, name, { max = 128, pattern = null } = {}) {
  if (typeof value !== 'string' || !value || value.length > max || (pattern && !pattern.test(value))) {
    fail(`${name} is invalid.`);
  }
  return value;
}

function isoUtc(value, name) {
  string(value, name, { max: 32, pattern: ISO_UTC_RE });
  if (Number.isNaN(Date.parse(value))) fail(`${name} is invalid.`);
  return value;
}

function decodeSegment(segment, name) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > MAX_COMPACT_BYTES) {
    fail(`Signed entitlement ${name} is invalid.`);
  }
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    fail(`Signed entitlement ${name} is invalid.`);
  }
}

function decodeJson(segment, name) {
  try {
    return JSON.parse(decodeSegment(segment, name).toString('utf8'));
  } catch (error) {
    if (error instanceof EntitlementValidationError) throw error;
    fail(`Signed entitlement ${name} is invalid.`);
  }
}

function verifyPublicKey(publicKey) {
  if (!publicKey) fail('A bundled or injected Ed25519 public key is required.');
  if (typeof publicKey === 'string' && /BEGIN (?:ENCRYPTED )?PRIVATE KEY/.test(publicKey)) {
    fail('A private key is not accepted for entitlement verification.');
  }
  let key;
  try {
    key = publicKey instanceof crypto.KeyObject ? publicKey : crypto.createPublicKey(publicKey);
  } catch {
    fail('The entitlement public key is invalid.');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    fail('The entitlement verification key must be an Ed25519 public key.');
  }
  return key;
}

function validateHeader(header) {
  object(header, 'header');
  exactKeys(header, HEADER_KEYS, 'header');
  if (header.alg !== 'EdDSA' || header.typ !== 'VIDMYO-ENTITLEMENT') {
    fail('Signed entitlement header is invalid.');
  }
  if (header.kid !== undefined) string(header.kid, 'header.kid', { max: 128, pattern: ID_RE });
}

export function validateEntitlementClaims(claims) {
  object(claims, 'claims');
  exactKeys(claims, CLAIM_KEYS, 'claims');
  for (const key of ['version', 'accountId', 'deviceId', 'plan', 'issuedAt', 'expiresAt', 'offlineGraceUntil', 'capabilities']) {
    if (!Object.hasOwn(claims, key)) fail(`claims.${key} is required.`);
  }
  if (claims.version !== 1) fail('claims.version is unsupported.');
  string(claims.accountId, 'claims.accountId', { pattern: ID_RE });
  string(claims.deviceId, 'claims.deviceId', { pattern: ID_RE });
  string(claims.plan, 'claims.plan', { max: 64, pattern: PLAN_RE });
  isoUtc(claims.issuedAt, 'claims.issuedAt');
  isoUtc(claims.expiresAt, 'claims.expiresAt');
  isoUtc(claims.offlineGraceUntil, 'claims.offlineGraceUntil');
  if (Date.parse(claims.expiresAt) < Date.parse(claims.issuedAt)) fail('claims.expiresAt precedes claims.issuedAt.');
  if (Date.parse(claims.offlineGraceUntil) < Date.parse(claims.expiresAt)) fail('claims.offlineGraceUntil precedes claims.expiresAt.');
  if (Date.parse(claims.offlineGraceUntil) - Date.parse(claims.expiresAt) > MAX_OFFLINE_GRACE_MS) {
    fail('claims.offlineGraceUntil exceeds the seven-day offline grace limit.');
  }
  if (!Array.isArray(claims.capabilities) || claims.capabilities.length > 128) fail('claims.capabilities is invalid.');
  const seen = new Set();
  for (const capability of claims.capabilities) {
    string(capability, 'claims.capabilities entry', { max: 96, pattern: CAPABILITY_RE });
    if (seen.has(capability)) fail('claims.capabilities contains duplicates.');
    seen.add(capability);
  }
  if (claims.status !== undefined && !['active', 'revoked'].includes(claims.status)) fail('claims.status is invalid.');
  return structuredClone({ ...claims, status: claims.status || 'active' });
}

export function verifySignedEntitlement(compact, { publicKey } = {}) {
  if (typeof compact !== 'string' || compact.length < 16 || compact.length > MAX_COMPACT_BYTES) {
    fail('Signed entitlement is invalid.');
  }
  const parts = compact.split('.');
  if (parts.length !== 3) fail('Signed entitlement is invalid.');
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson(encodedHeader, 'header');
  validateHeader(header);
  const claims = validateEntitlementClaims(decodeJson(encodedClaims, 'claims'));
  const signature = decodeSegment(encodedSignature, 'signature');
  if (signature.length !== 64) fail('Signed entitlement signature is invalid.');
  const verified = crypto.verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), verifyPublicKey(publicKey), signature);
  if (!verified) fail('Signed entitlement signature is invalid.');
  return claims;
}

function nowMs(now) {
  const value = now instanceof Date ? now.getTime() : new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(value)) fail('Entitlement clock is invalid.');
  return value;
}

export function entitlementStatus(claims, { now } = {}) {
  const valid = validateEntitlementClaims(claims);
  if (valid.status === 'revoked') return 'revoked';
  const time = nowMs(now);
  if (time <= Date.parse(valid.expiresAt)) return 'active';
  if (time <= Date.parse(valid.offlineGraceUntil)) return 'offline_grace';
  return 'expired';
}

export function evaluateEntitlement(claims, options = {}) {
  const valid = validateEntitlementClaims(claims);
  const status = entitlementStatus(valid, options);
  return {
    claims: valid,
    status,
    protectedAllowed: status === 'active' || status === 'offline_grace',
    localProjectsReadable: true,
  };
}

export function authorizeEntitlementCapability(claims, capability, { protectedCapability = true, now } = {}) {
  string(capability, 'capability', { max: 96, pattern: CAPABILITY_RE });
  if (!protectedCapability) return { allowed: true, reason: 'local_unprotected', status: 'local' };
  const evaluation = evaluateEntitlement(claims, { now });
  if (!evaluation.protectedAllowed) return { allowed: false, reason: evaluation.status, status: evaluation.status };
  if (!evaluation.claims.capabilities.includes(capability)) return { allowed: false, reason: 'capability_not_entitled', status: evaluation.status };
  return { allowed: true, reason: evaluation.status, status: evaluation.status };
}
