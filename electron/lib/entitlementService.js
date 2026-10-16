// Main-process subscription control-plane client.
//
// The service only talks to the configured Vidmyo HTTPS origin. It sends
// authentication/device and bounded team-claim metadata; customer projects,
// media, prompts, and proprietary pipeline payloads never cross this boundary.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_KEY = 'vidmyo.entitlement.access-token.v1';
const CACHE_KEY = 'vidmyo.entitlement.cache.v1';
const TEAM_ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const LEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function boundedString(value, max = 256) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function normalizeServiceUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new TypeError('VIDMYO_SERVICE_URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('VIDMYO_SERVICE_URL must be a credential-free HTTPS URL.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.search = '';
  return url;
}

function fixedEndpoint(base, name) {
  return new URL(name, base).toString();
}

function validLeaseMs(value) {
  return Number.isInteger(value) && value >= 60_000 && value <= 24 * 60 * 60 * 1000;
}

function validRevision(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function requireTeamClaim(input, { renewal = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('A team-claim request is required.');
  const allowed = renewal
    ? ['itemId', 'expectedRevision', 'leaseMs', 'leaseId', 'idempotencyKey']
    : ['itemId', 'expectedRevision', 'leaseMs', 'idempotencyKey'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new TypeError(`Unsupported team-claim field: ${key}.`);
  if (typeof input.itemId !== 'string' || !TEAM_ITEM_RE.test(input.itemId)) throw new TypeError('itemId is invalid.');
  if (!validRevision(input.expectedRevision)) throw new TypeError('expectedRevision is invalid.');
  if (!validLeaseMs(input.leaseMs)) throw new TypeError('leaseMs is invalid.');
  if (typeof input.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(input.idempotencyKey)) {
    throw new TypeError('idempotencyKey is invalid.');
  }
  if (renewal && (typeof input.leaseId !== 'string' || !LEASE_ID_RE.test(input.leaseId))) throw new TypeError('leaseId is invalid.');
  return Object.fromEntries(allowed.map(key => [key, input[key]]));
}

async function responseJson(response) {
  if (!response || typeof response !== 'object') throw new Error('invalid-response');
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (typeof text !== 'string' || text.length > 16 * 1024) throw new Error('invalid-response');
    try { return JSON.parse(text); } catch { throw new Error('invalid-response'); }
  }
  if (typeof response.json === 'function') {
    const value = await response.json();
    const text = JSON.stringify(value);
    if (text.length > 16 * 1024) throw new Error('invalid-response');
    return value;
  }
  throw new Error('invalid-response');
}

function sanitizedClaim(value) {
  const claim = value?.claim || value;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('invalid-response');
  const itemId = boundedString(claim.itemId, 128);
  const leaseId = boundedString(claim.leaseId, 128);
  const expiresAt = boundedString(claim.expiresAt, 32);
  if (!TEAM_ITEM_RE.test(itemId) || !LEASE_ID_RE.test(leaseId) || !/^\d{4}-\d{2}-\d{2}T/.test(expiresAt) || !validRevision(claim.revision)) {
    throw new Error('invalid-response');
  }
  return { itemId, revision: claim.revision, leaseId, expiresAt };
}

function publicFailure(code, { status = null } = {}) {
  return { ok: false, code, ...(status ? { status } : {}), localProjectsReadable: true };
}

function createEntitlementService(deps = {}) {
  const secureStore = deps.secureStore;
  if (!secureStore || typeof secureStore.get !== 'function' || typeof secureStore.set !== 'function') {
    throw new TypeError('Entitlement service requires an injected encrypted secureStore.');
  }
  const baseUrl = normalizeServiceUrl(deps.serviceUrl || process.env.VIDMYO_SERVICE_URL);
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('Entitlement service requires fetch.');
  const publicKey = deps.publicKey;
  if (!publicKey) throw new TypeError('Entitlement service requires a bundled or injected publicKey.');
  const loadCore = deps.core || (() => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'core', 'index.js')).href));
  const now = deps.now || (() => new Date());
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  let timer = null;

  async function read(key) {
    const value = await secureStore.get(key);
    return typeof value === 'string' ? value : null;
  }

  async function storeCache(compact) {
    await secureStore.set(CACHE_KEY, JSON.stringify({ compact, savedAt: new Date(now()).toISOString() }));
  }

  async function cached(core) {
    const value = await read(CACHE_KEY);
    if (!value) return null;
    try {
      const record = JSON.parse(value);
      if (!record || typeof record.compact !== 'string') return null;
      const claims = core.verifySignedEntitlement(record.compact, { publicKey });
      return core.evaluateEntitlement(claims, { now: now() });
    } catch {
      return null;
    }
  }

  async function cachedForNetworkFailure(core) {
    const evaluation = await cached(core);
    if (!evaluation) return publicFailure('network_unavailable');
    if (!evaluation.protectedAllowed) return publicFailure('entitlement_expired', { status: evaluation.status });
    return {
      ok: true,
      source: 'cached',
      status: evaluation.status,
      entitlement: evaluation.claims,
      localProjectsReadable: true,
    };
  }

  async function accessToken() { return read(ACCESS_TOKEN_KEY); }

  async function authorizedRequest(url, body) {
    const token = await accessToken();
    if (!token) return { authenticationRequired: true };
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { response };
  }

  async function refresh() {
    const core = await loadCore();
    let result;
    try {
      result = await authorizedRequest(fixedEndpoint(baseUrl, 'v1/desktop/entitlements/refresh'), {});
    } catch {
      return cachedForNetworkFailure(core);
    }
    if (result.authenticationRequired) return publicFailure('authentication_required');
    const response = result.response;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return publicFailure('authentication_required');
      if (response.status >= 500) return cachedForNetworkFailure(core);
      return publicFailure('service_rejected');
    }
    try {
      const body = await responseJson(response);
      if (!body || typeof body.entitlement !== 'string' || body.entitlement.length > 16 * 1024) throw new Error('invalid-response');
      const claims = core.verifySignedEntitlement(body.entitlement, { publicKey });
      const evaluation = core.evaluateEntitlement(claims, { now: now() });
      await storeCache(body.entitlement);
      if (!evaluation.protectedAllowed) return publicFailure('entitlement_expired', { status: evaluation.status });
      return { ok: true, source: 'network', status: evaluation.status, entitlement: evaluation.claims, localProjectsReadable: true };
    } catch {
      return publicFailure('invalid_entitlement');
    }
  }

  async function current() {
    const core = await loadCore();
    const evaluation = await cached(core);
    if (!evaluation) return publicFailure('entitlement_unavailable');
    if (!evaluation.protectedAllowed) return publicFailure('entitlement_expired', { status: evaluation.status });
    return { ok: true, source: 'cached', status: evaluation.status, entitlement: evaluation.claims, localProjectsReadable: true };
  }

  async function teamClaim(input, renewal = false) {
    const request = requireTeamClaim(input, { renewal });
    let result;
    try {
      result = await authorizedRequest(fixedEndpoint(baseUrl, renewal ? 'v1/team/claims/renew' : 'v1/team/claims/acquire'), request);
    } catch {
      return { ok: false, code: 'network_unavailable' };
    }
    if (result.authenticationRequired) return { ok: false, code: 'authentication_required' };
    if (result.response.status === 409) return { ok: false, code: 'claim_conflict' };
    if (!result.response.ok) return { ok: false, code: result.response.status === 401 || result.response.status === 403 ? 'authentication_required' : 'service_rejected' };
    try {
      return { ok: true, claim: sanitizedClaim(await responseJson(result.response)) };
    } catch {
      return { ok: false, code: 'invalid_claim_response' };
    }
  }

  function start() {
    if (timer !== null) return;
    void refresh().catch(() => {});
    timer = setIntervalFn(() => { void refresh().catch(() => {}); }, DAY_MS);
  }

  function stop() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return Object.freeze({
    setAccessToken: async token => {
      if (typeof token !== 'string' || !token.trim() || token.length > 4096) throw new TypeError('Access token is invalid.');
      await secureStore.set(ACCESS_TOKEN_KEY, token);
    },
    clearAccessToken: async () => {
      if (typeof secureStore.delete === 'function') await secureStore.delete(ACCESS_TOKEN_KEY);
      else await secureStore.set(ACCESS_TOKEN_KEY, '');
    },
    refresh,
    current,
    claimTeamWork: input => teamClaim(input, false),
    renewTeamWork: input => teamClaim(input, true),
    start,
    stop,
  });
}

module.exports = {
  ACCESS_TOKEN_KEY,
  CACHE_KEY,
  DAY_MS,
  createEntitlementService,
};
