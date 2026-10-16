// Native Google OAuth for desktop Electron builds.
//
// Credentials and tokens stay in the main process. Both are encrypted with
// Electron safeStorage before being written under app userData. The renderer
// receives only account/status metadata and read-only API results.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES = Object.freeze([
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
]);
const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/oauth2/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const ALLOWED_AUTH_URIS = new Set([AUTH_URL, 'https://accounts.google.com/o/oauth2/auth']);
const ALLOWED_API_HOSTS = new Set(['www.googleapis.com', 'sheets.googleapis.com', 'openidconnect.googleapis.com']);

function redact(error) {
  return String(error?.message || error || 'Google request failed')
    .replace(/https?:\/\/[^\s]+/gi, '[URL omitted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [credential omitted]')
    .replace(/(["']?(?:access_token|refresh_token|client_secret|code)["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, '$1[credential omitted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function parseClientJson(value) {
  const root = typeof value === 'string' ? JSON.parse(value) : value;
  const client = root?.installed;
  if (!client || typeof client !== 'object') throw new Error('Choose a Google OAuth client JSON file for a Desktop app.');
  const clientId = String(client.client_id || '').trim();
  const clientSecret = String(client.client_secret || '').trim();
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) {
    throw new Error('The selected file is not a valid Google Desktop OAuth client.');
  }
  if (client.auth_uri && !ALLOWED_AUTH_URIS.has(client.auth_uri)) throw new Error('The OAuth authorization endpoint is not supported.');
  if (client.token_uri && client.token_uri !== TOKEN_URL) throw new Error('The OAuth token endpoint is not supported.');
  return { clientId, clientSecret };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hasRequiredScopes(scope, requiredScopes = SCOPES) {
  const granted = new Set(String(scope || '').split(/\s+/).filter(Boolean));
  return requiredScopes.every((required) => granted.has(required));
}

function html(message) {
  const safe = String(message).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<!doctype html><meta charset="utf-8"><title>Vidmyo Google sign-in</title><body style="font:16px system-ui;padding:3rem;max-width:42rem"><h1>${safe}</h1><p>You can close this tab and return to Vidmyo.</p></body>`;
}

function createGoogleOAuth(deps = {}) {
  const app = deps.app;
  const dialog = deps.dialog;
  const safeStorage = deps.safeStorage;
  const shell = deps.shell;
  const fetchImpl = deps.fetchImpl || global.fetch;
  const fsImpl = deps.fs || fs;
  const httpImpl = deps.http || http;
  const cryptoImpl = deps.crypto || crypto;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = deps.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const requestedScopes = Array.isArray(deps.scopes) && deps.scopes.length ? [...deps.scopes] : [...SCOPES];
  if (!app || !safeStorage) throw new Error('Google OAuth requires Electron app and safeStorage dependencies.');

  const storeFile = deps.storeFile || path.join(app.getPath('userData'), 'google-oauth.json');
  const bundledCandidates = deps.bundledClientPaths || [
    process.resourcesPath ? path.join(process.resourcesPath, 'google-oauth-client.json') : null,
    app.getAppPath?.() ? path.join(app.getAppPath(), 'resources', 'google-oauth-client.json') : null,
  ].filter(Boolean);
  let activeLogin = null;
  let cancelActiveLogin = null;
  let activeRefresh = null;
  let loginGeneration = 0;

  function encryptionAvailable() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      // Electron's Linux `basic_text` backend is reversible obfuscation rather
      // than OS credential protection, so do not persist OAuth material there.
      if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }

  async function googleFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    } finally { clearTimeout(timer); }
  }

  function readStore() {
    try {
      const value = JSON.parse(fsImpl.readFileSync(storeFile, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function writeStore(value) {
    fsImpl.mkdirSync(path.dirname(storeFile), { recursive: true });
    const temp = `${storeFile}.tmp-${process.pid}`;
    fsImpl.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fsImpl.renameSync(temp, storeFile);
    try { fsImpl.chmodSync(storeFile, 0o600); } catch { /* best effort on Windows */ }
  }

  function encrypt(value) {
    if (!encryptionAvailable()) throw new Error('Secure operating-system storage is unavailable. Google Connect is disabled.');
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  }

  function decrypt(blob) {
    if (!blob || !encryptionAvailable()) return null;
    try { return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))); } catch { return null; }
  }

  function bundledClient() {
    for (const candidate of bundledCandidates) {
      if (!candidate) continue;
      try { return parseClientJson(fsImpl.readFileSync(candidate, 'utf8')); } catch { /* missing/invalid bundles are ignored */ }
    }
    return null;
  }

  function client() {
    const imported = decrypt(readStore().client);
    if (imported) {
      try { return parseClientJson({ installed: { client_id: imported.clientId, client_secret: imported.clientSecret } }); } catch { /* fall through */ }
    }
    return bundledClient();
  }

  function token() {
    const value = decrypt(readStore().token);
    return value && typeof value === 'object' ? value : null;
  }

  function saveToken(update) {
    const store = readStore();
    const previous = token() || {};
    store.token = encrypt({ ...previous, ...update });
    writeStore(store);
  }

  function clearToken() {
    const store = readStore();
    delete store.token;
    writeStore(store);
  }

  async function responseJson(response, label) {
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok || !data || typeof data !== 'object') {
      const detail = data?.error_description || data?.error?.message || data?.error || `${response.status || ''}`;
      throw new Error(`${label} failed. ${redact(detail)}`.trim());
    }
    return data;
  }

  async function performRefresh() {
    const credentials = client();
    const current = token();
    if (!credentials || !current?.refreshToken) throw new Error('Google is not connected.');
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: current.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await googleFetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = await responseJson(response, 'Google token refresh');
    const expiresIn = Number(data.expires_in || 3600);
    saveToken({ accessToken: data.access_token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000, scope: data.scope || current.scope });
    return data.access_token;
  }

  async function refresh() {
    if (!activeRefresh) {
      activeRefresh = performRefresh().finally(() => { activeRefresh = null; });
    }
    return activeRefresh;
  }

  async function accessToken() {
    const current = token();
    if (!current?.refreshToken) throw new Error('Google is not connected.');
    if (current.accessToken && Number(current.expiresAt) > Date.now() + 60_000) return current.accessToken;
    return refresh();
  }

  async function apiJson(url, options = {}) {
    const target = new URL(url);
    const method = String(options.method || 'GET').toUpperCase();
    if (target.protocol !== 'https:' || !ALLOWED_API_HOSTS.has(target.hostname) || method !== 'GET') {
      throw new Error('Google API request was blocked by the read-only destination policy.');
    }
    let access = await accessToken();
    const request = () => googleFetch(target.toString(), { ...options, method, headers: { ...(options.headers || {}), authorization: `Bearer ${access}`, accept: 'application/json' } });
    let response = await request();
    if (response.status === 401) {
      access = await refresh();
      response = await request();
    }
    return responseJson(response, 'Google API request');
  }

  function allowedSheetsWrite(target, method) {
    if (target.protocol !== 'https:' || target.hostname !== 'sheets.googleapis.com') return false;
    const pathname = target.pathname;
    if (method === 'POST' && pathname === '/v4/spreadsheets') return true;
    if (!/^\/v4\/spreadsheets\/[A-Za-z0-9_-]{20,}(?:\/|:|$)/.test(pathname)) return false;
    if (method === 'PUT' && /^\/v4\/spreadsheets\/[A-Za-z0-9_-]{20,}\/values\/[^/]+$/.test(pathname)) return true;
    if (method === 'POST' && /^\/v4\/spreadsheets\/[A-Za-z0-9_-]{20,}\/values\/[^/]+:(?:append|clear)$/.test(pathname)) return true;
    if (method === 'POST' && /^\/v4\/spreadsheets\/[A-Za-z0-9_-]{20,}(?::batchUpdate|\/values:batchUpdate)$/.test(pathname)) return true;
    return false;
  }

  async function writeJson(url, options = {}) {
    const target = new URL(url);
    const method = String(options.method || 'POST').toUpperCase();
    if (!allowedSheetsWrite(target, method)) {
      throw new Error('Google API request was blocked by the Sheets write destination policy.');
    }
    if (!options.body || typeof options.body !== 'object' || Array.isArray(options.body)) {
      throw new Error('Google Sheets write body must be a JSON object.');
    }
    let access = await accessToken();
    const request = () => googleFetch(target.toString(), {
      method,
      headers: {
        ...(options.headers || {}),
        authorization: `Bearer ${access}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(options.body),
    });
    let response = await request();
    if (response.status === 401) {
      access = await refresh();
      response = await request();
    }
    return responseJson(response, 'Google Sheets write');
  }

  async function account() {
    if (!encryptionAvailable()) return { available: false, configured: Boolean(client()), connected: false, reason: 'secure-storage-unavailable' };
    const configured = Boolean(client());
    const current = token();
    if (!configured) return { available: true, configured: false, connected: false, reason: 'oauth-client-missing' };
    if (!current?.refreshToken) return { available: true, configured: true, connected: false, reason: 'signed-out' };
    if (current.scope && !hasRequiredScopes(current.scope, requestedScopes)) {
      return { available: true, configured: true, connected: false, reason: 'authorization-expired', error: 'Google access is missing a required Sheets permission. Disconnect and connect Google again.' };
    }
    try {
      let email = String(current.email || '');
      if (!email) {
        const profile = await apiJson(USERINFO_URL);
        email = String(profile.email || '');
        saveToken({ email });
      } else await accessToken();
      return { available: true, configured: true, connected: true, reason: 'connected', email };
    } catch (error) {
      return { available: true, configured: true, connected: false, reason: 'authorization-expired', error: redact(error) };
    }
  }

  async function setup() {
    if (!encryptionAvailable()) return { ok: false, error: 'Secure operating-system storage is unavailable. Google Connect is disabled.' };
    const result = await dialog.showOpenDialog({
      title: 'Choose the Vidmyo Google Desktop OAuth client JSON',
      properties: ['openFile'],
      filters: [{ name: 'Google OAuth client', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true, error: 'cancelled' };
    try {
      const parsed = parseClientJson(fsImpl.readFileSync(result.filePaths[0], 'utf8'));
      loginGeneration += 1;
      cancelActiveLogin?.('Google sign-in was cancelled because the OAuth configuration changed.');
      const store = readStore();
      store.client = encrypt(parsed);
      delete store.token;
      writeStore(store);
      return { ok: true, ...(await account()) };
    } catch (error) { return { ok: false, error: redact(error) }; }
  }

  async function connect() {
    if (activeLogin) return { ok: false, error: 'Google sign-in is already in progress.' };
    if (!encryptionAvailable()) return { ok: false, error: 'Secure operating-system storage is unavailable. Google Connect is disabled.' };
    const credentials = client();
    if (!credentials) return { ok: false, error: 'Google Connect needs a Desktop OAuth client. Import the release-owned client JSON first.' };

    const verifier = base64url(cryptoImpl.randomBytes(48));
    const challenge = cryptoImpl.createHash('sha256').update(verifier).digest('base64url');
    const state = base64url(cryptoImpl.randomBytes(32));
    const generation = ++loginGeneration;
    let server;
    let timer;
    activeLogin = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (!result?.ok && generation === loginGeneration) loginGeneration += 1;
        if (timer) clearTimeout(timer);
        if (server?.listening) server.close(() => {});
        activeLogin = null;
        cancelActiveLogin = null;
        resolve(result);
      };
      cancelActiveLogin = (message) => finish({ ok: false, error: message });
      server = httpImpl.createServer(async (request, response) => {
        try {
          const incoming = new URL(request.url, `http://${LOOPBACK_HOST}`);
          if (incoming.pathname !== CALLBACK_PATH) {
            response.writeHead(404).end();
            return;
          }
          if (incoming.searchParams.get('state') !== state) throw new Error('Google sign-in state did not match. Please try again.');
          const oauthError = incoming.searchParams.get('error');
          if (oauthError) throw new Error(oauthError === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${oauthError}`);
          const code = incoming.searchParams.get('code');
          if (!code) throw new Error('Google did not return an authorization code.');
          const port = server.address().port;
          const redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
          const body = new URLSearchParams({ code, client_id: credentials.clientId, client_secret: credentials.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
          const exchanged = await googleFetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
          const data = await responseJson(exchanged, 'Google sign-in');
          if (!data.refresh_token) throw new Error('Google did not return a refresh token. Remove Vidmyo from Google account access and try again.');
          if (!hasRequiredScopes(data.scope, requestedScopes)) throw new Error('Google did not grant every required permission. Try again and approve the requested access.');
          if (generation !== loginGeneration) throw new Error('Google sign-in was cancelled.');
          saveToken({ refreshToken: data.refresh_token, accessToken: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000, scope: data.scope || '', email: '' });
          const profile = await apiJson(USERINFO_URL);
          if (generation !== loginGeneration) {
            clearToken();
            throw new Error('Google sign-in was cancelled.');
          }
          saveToken({ email: String(profile.email || '') });
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('Google connected to Vidmyo'));
          finish({ ok: true, ...(await account()) });
        } catch (error) {
          response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(html('Google sign-in did not complete'));
          finish({ ok: false, error: redact(error) });
        }
      });
      server.once('error', (error) => finish({ ok: false, error: `Could not start the local Google sign-in callback. ${redact(error)}` }));
      server.listen(0, LOOPBACK_HOST, async () => {
        const redirectUri = `http://${LOOPBACK_HOST}:${server.address().port}${CALLBACK_PATH}`;
        const auth = new URL(AUTH_URL);
        for (const [key, value] of Object.entries({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: 'code', scope: requestedScopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) auth.searchParams.set(key, value);
        try { await shell.openExternal(auth.toString()); }
        catch (error) { finish({ ok: false, error: `Could not open the system browser. ${redact(error)}` }); }
      });
      timer = setTimeout(() => finish({ ok: false, error: 'Google sign-in timed out. Try again.' }), timeoutMs);
    });
    return activeLogin;
  }

  async function disconnect() {
    loginGeneration += 1;
    cancelActiveLogin?.('Google sign-in was cancelled by disconnecting.');
    const current = token();
    clearToken();
    if (current?.accessToken || current?.refreshToken) {
      const credential = current.accessToken || current.refreshToken;
      try {
        await googleFetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credential }) });
      } catch { /* local disconnect succeeds even while offline */ }
    }
    return { ok: true, available: encryptionAvailable(), configured: Boolean(client()), connected: false, reason: 'signed-out' };
  }

  return { account, setup, connect, disconnect, apiJson, writeJson, accessToken, refresh, parseClientJson };
}

module.exports = { createGoogleOAuth, parseClientJson, redact, hasRequiredScopes, SCOPES, AUTH_URL, TOKEN_URL };
