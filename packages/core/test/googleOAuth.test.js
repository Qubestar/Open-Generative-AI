import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createGoogleOAuth, parseClientJson, SCOPES } = require('../../../electron/lib/googleOAuth.js');

const CLIENT_ID = '123456789-test.apps.googleusercontent.com';
const CLIENT_SECRET = 'desktop-secret-for-test';
const clientJson = JSON.stringify({ installed: {
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  redirect_uris: ['http://localhost'],
} });

function safeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
    decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString(),
  };
}

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-google-oauth-'));
  const clientFile = path.join(dir, 'client.json');
  fs.writeFileSync(clientFile, clientJson);
  const service = createGoogleOAuth({
    app: { getPath: () => dir, getAppPath: () => dir },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [clientFile] }) },
    safeStorage: safeStorage(),
    shell: { openExternal: async () => {} },
    bundledClientPaths: [],
    timeoutMs: 1000,
    fetchImpl: async () => { throw new Error('unexpected fetch'); },
    ...overrides,
  });
  return { service, dir, storeFile: path.join(dir, 'google-oauth.json') };
}

test('validates only installed Desktop OAuth client JSON', () => {
  assert.deepEqual(parseClientJson(clientJson), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.deepEqual(parseClientJson(JSON.stringify({ installed: {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
  } })), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.throws(() => parseClientJson(JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } })), /Desktop app/);
  assert.deepEqual(SCOPES, [
    'openid', 'email',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
});

test('imports OAuth client through the native dialog and stores no plaintext credentials', async () => {
  const { service, storeFile } = harness();
  const result = await service.setup();
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.connected, false);
  const raw = fs.readFileSync(storeFile, 'utf8');
  assert.doesNotMatch(raw, new RegExp(CLIENT_ID.replaceAll('.', '\\.')));
  assert.doesNotMatch(raw, new RegExp(CLIENT_SECRET));
  assert.equal(fs.statSync(storeFile).mode & 0o777, 0o600);
});

test('fails closed when Electron safeStorage encryption is unavailable', async () => {
  const { service } = harness({ safeStorage: safeStorage(false) });
  assert.deepEqual(await service.account(), {
    available: false, configured: false, connected: false, reason: 'secure-storage-unavailable',
  });
  assert.match((await service.setup()).error, /Secure operating-system storage/);
  assert.match((await service.connect()).error, /Secure operating-system storage/);
});

test('fails closed for Electron Linux basic_text storage', async () => {
  const storage = { ...safeStorage(), getSelectedStorageBackend: () => 'basic_text' };
  const { service } = harness({ safeStorage: storage });
  assert.equal((await service.account()).reason, 'secure-storage-unavailable');
  assert.match((await service.setup()).error, /Secure operating-system storage/);
});

test('rejects an invalid OAuth state, closes the listener, and permits a fresh login', async () => {
  let openCount = 0;
  const opened = [];
  const { service } = harness({
    shell: { openExternal: async (url) => {
      openCount += 1;
      opened.push(url);
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      if (openCount === 1) callback.searchParams.set('state', 'wrong-state');
      else {
        callback.searchParams.set('state', auth.searchParams.get('state'));
        callback.searchParams.set('error', 'access_denied');
      }
      setImmediate(() => fetch(callback).catch(() => {}));
    } },
  });
  await service.setup();
  const invalid = await service.connect();
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /state did not match/);

  const retry = await service.connect();
  assert.equal(retry.ok, false);
  assert.match(retry.error, /cancelled/);
  assert.equal(openCount, 2);
  assert.equal(new URL(opened[0]).searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(opened[0]).searchParams.get('redirect_uri').startsWith('http://127.0.0.1:'), true);
});

test('exchanges, refreshes, and revokes tokens without returning them to account callers', async () => {
  const requests = [];
  let authUrl;
  const { service, storeFile } = harness({
    shell: { openExternal: async (url) => {
      authUrl = new URL(url);
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'one-time-code');
      setImmediate(() => fetch(callback).catch(() => {}));
    } },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: SCOPES.join(' ') }), { status: 200 });
      if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ email: 'reader@example.com' }), { status: 200 });
      if (String(url).includes('/revoke')) return new Response('', { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await service.setup();
  const connected = await service.connect();
  assert.deepEqual(connected, { ok: true, available: true, configured: true, connected: true, reason: 'connected', email: 'reader@example.com' });
  assert.equal('accessToken' in connected, false);
  assert.doesNotMatch(fs.readFileSync(storeFile, 'utf8'), /access-secret|refresh-secret|desktop-secret/);
  const tokenBody = String(requests.find((item) => item.url.includes('/token')).options.body);
  assert.match(tokenBody, /code_verifier=/);
  assert.equal(authUrl.searchParams.get('scope'), SCOPES.join(' '));

  const disconnected = await service.disconnect();
  assert.equal(disconnected.connected, false);
  assert.equal(requests.some((item) => item.url.includes('/revoke')), true);
  assert.doesNotMatch(fs.readFileSync(storeFile, 'utf8'), /refresh-secret/);
});

test('coalesces concurrent access-token refreshes into one token request', async () => {
  let tokenRequests = 0;
  let authUrl;
  const storage = safeStorage();
  const { service, storeFile } = harness({
    safeStorage: storage,
    shell: { openExternal: async (url) => {
      authUrl = new URL(url);
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'one-time-code');
      setImmediate(() => fetch(callback).catch(() => {}));
    } },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/token')) {
        tokenRequests += 1;
        const body = new URLSearchParams(String(options.body || ''));
        if (body.get('grant_type') === 'authorization_code') {
          return new Response(JSON.stringify({ access_token: 'initial-access', refresh_token: 'refresh-secret', expires_in: 3600, scope: SCOPES.join(' ') }), { status: 200 });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ email: 'reader@example.com' }), { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await service.setup();
  assert.equal((await service.connect()).ok, true);

  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const saved = JSON.parse(storage.decryptString(Buffer.from(store.token, 'base64')));
  saved.expiresAt = 0;
  store.token = storage.encryptString(JSON.stringify(saved)).toString('base64');
  fs.writeFileSync(storeFile, JSON.stringify(store));

  const values = await Promise.all([service.accessToken(), service.accessToken(), service.accessToken()]);
  assert.deepEqual(values, ['access-2', 'access-2', 'access-2']);
  assert.equal(tokenRequests, 2, 'one authorization-code exchange plus one shared refresh');
});

test('disconnect invalidates an in-flight exchange before it can persist a late token', async () => {
  let releaseExchange;
  let exchangeStarted;
  const started = new Promise((resolve) => { exchangeStarted = resolve; });
  const { service, storeFile } = harness({
    shell: { openExternal: async (url) => {
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state'));
      callback.searchParams.set('code', 'late-code');
      setImmediate(() => fetch(callback).catch(() => {}));
    } },
    fetchImpl: async (url) => {
      if (!String(url).includes('/token')) throw new Error(`unexpected URL ${url}`);
      exchangeStarted();
      await new Promise((resolve) => { releaseExchange = resolve; });
      return new Response(JSON.stringify({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope: SCOPES.join(' ') }), { status: 200 });
    },
  });
  await service.setup();
  const connecting = service.connect();
  await started;
  await service.disconnect();
  releaseExchange();
  assert.match((await connecting).error, /cancelled by disconnecting/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(fs.readFileSync(storeFile, 'utf8'), /late-access|late-refresh/);
  assert.equal((await service.account()).connected, false);
});

test('keeps reads allowlisted and permits only defined JSON Google Sheets writes', async () => {
  const { service } = harness();
  await assert.rejects(service.apiJson('https://example.com/private'), /destination policy/);
  await assert.rejects(service.apiJson('https://sheets.googleapis.com/v4/spreadsheets/x', { method: 'POST' }), /destination policy/);
  await assert.rejects(service.writeJson('https://example.com/v4/spreadsheets', { body: {} }), /destination policy/);
  await assert.rejects(service.writeJson('https://sheets.googleapis.com/v4/spreadsheets/x', { body: {} }), /destination policy/);
  await assert.rejects(service.writeJson('https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/values/A1:Z9', { method: 'DELETE', body: {} }), /destination policy/);
  await assert.rejects(service.writeJson('https://sheets.googleapis.com/v4/spreadsheets', { body: [] }), /JSON object/);
});

test('sends an authenticated JSON Sheets create request after explicit Google Connect', async () => {
  let authUrl;
  let writeRequest;
  const { service } = harness({
    shell: { openExternal: async (url) => {
      authUrl = new URL(url);
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'one-time-code');
      setImmediate(() => fetch(callback).catch(() => {}));
    } },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: SCOPES.join(' ') }), { status: 200 });
      if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ email: 'writer@example.com' }), { status: 200 });
      if (String(url) === 'https://sheets.googleapis.com/v4/spreadsheets') {
        writeRequest = { url: String(url), options };
        return new Response(JSON.stringify({ spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await service.setup();
  assert.equal((await service.connect()).ok, true);
  const result = await service.writeJson('https://sheets.googleapis.com/v4/spreadsheets', { body: { properties: { title: 'Tracker' } } });
  assert.equal(result.spreadsheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(writeRequest.options.headers.authorization, 'Bearer access-secret');
  assert.equal(writeRequest.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(writeRequest.options.body), { properties: { title: 'Tracker' } });
});
