// Read-only Google Sheets bridge for Story intake.
//
// Authenticated access is delegated to the Google Workspace CLI (`gws`),
// which keeps OAuth credentials in the operating-system keyring. A pasted
// Viewer link can be read through Google's CSV export without authentication.
// This module stores only the selected spreadsheet/tab in story-config.json.

const { execFile: systemExecFile } = require('child_process');
const path = require('path');

const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
const MAX_PAGE_TOKEN = 4096;
const MAX_TAB_LENGTH = 200;
const ROW_LIMIT = 1000;
const READ_END_ROW = ROW_LIMIT + 2; // header + limit + one overflow sentinel
const GWS_SETUP_HINT = 'Private Google Sheets are not enabled on this installation. You can continue now by pasting a Viewer shared link below. The Vidmyo release owner must enable Google Connect for this build.';
const OAUTH_SETUP_HINT = 'Google Connect needs one-time app setup and is not ready on this installation. You can continue now by pasting a Viewer shared link below.';

const ACCOUNT_STATE = Object.freeze({
  CONNECTED: 'connected',
  CONNECT_READY: 'connect-ready',
  SETUP_REQUIRED: 'setup-required',
  UNAVAILABLE: 'unavailable',
});

const ACCOUNT_ACTION = Object.freeze({
  BROWSE: 'browse-private-sheets',
  CONNECT: 'connect-google',
  SHARED_LINK: 'use-viewer-link',
  RETRY: 'retry-account-check',
});

const HEADER_ALIASES = {
  title: [
    'working title', 'video title', 'title', 'topic title', 'video topic',
    'video idea', 'idea', 'tytul roboczy', 'tytul', 'temat filmu',
  ],
  status: ['status', 'production status', 'video status', 'state', 'stan', 'status produkcji'],
  videoNum: ['video number', 'video no', 'video nr', 'video', 'number', 'no', 'nr', 'numer', 'numer filmu'],
  hook: ['hook', 'opening hook', 'intro hook', 'first line', 'opening line', 'haczyk', 'otwarcie'],
  topic: [
    'topic angle', 'topic and angle', 'angle', 'description', 'video description',
    'brief', 'details', 'story direction', 'concept', 'topic', 'temat', 'opis', 'kat',
  ],
};

function fail(error) {
  return { ok: false, error: String(error?.message || error || 'Unknown error').slice(0, 1000) };
}

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/#/g, ' number ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findAlias(headers, aliases, excluded = new Set()) {
  for (const alias of aliases) {
    const index = headers.findIndex((header, candidate) => header === alias && !excluded.has(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

function columnsFor(headerRow) {
  const headers = (headerRow || []).map(normalizeHeader);
  const used = new Set();
  const title = findAlias(headers, HEADER_ALIASES.title, used);
  if (title >= 0) used.add(title);
  const status = findAlias(headers, HEADER_ALIASES.status, used);
  if (status >= 0) used.add(status);
  const videoNum = findAlias(headers, HEADER_ALIASES.videoNum, used);
  if (videoNum >= 0) used.add(videoNum);
  const hook = findAlias(headers, HEADER_ALIASES.hook, used);
  if (hook >= 0) used.add(hook);
  const topic = findAlias(headers, HEADER_ALIASES.topic, used);
  return { title, status, videoNum, hook, topic };
}

function detectHeader(values) {
  let best = null;
  for (let row = 0; row < Math.min((values || []).length, 10); row += 1) {
    const columns = columnsFor(values[row]);
    if (columns.title < 0) continue;
    const score = 4 + ['status', 'videoNum', 'hook', 'topic'].filter((key) => columns[key] >= 0).length;
    if (!best || score > best.score) best = { row, columns, score };
  }
  if (best) return best;

  // Curio and Superius trackers historically use A:E in this order. Keep
  // this compatibility path only when the first row looks like a five-column
  // header; there is no implicit spreadsheet ID or automatic tracker load.
  if ((values?.[0]?.length || 0) >= 5) {
    return { row: 0, columns: { status: 0, videoNum: 1, title: 2, hook: 3, topic: 4 }, score: 0, fallback: true };
  }
  return null;
}

function mapSheetRows(values, { limit = ROW_LIMIT } = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    return { rows: [], headerRow: null, columns: null, truncated: false };
  }
  const header = detectHeader(values);
  if (!header) {
    throw new Error('Could not find a title column. Add a header such as “Title” or “Working Title”, then load the worksheet again.');
  }
  const rows = [];
  let sawBeyondLimit = false;
  for (let index = header.row + 1; index < values.length; index += 1) {
    const source = Array.isArray(values[index]) ? values[index] : [];
    const get = (column) => column >= 0 ? String(source[column] ?? '').trim() : '';
    const title = get(header.columns.title);
    if (!title) continue;
    if (rows.length >= limit) {
      sawBeyondLimit = true;
      break;
    }
    const topic = get(header.columns.topic);
    rows.push({
      row: index + 1,
      title,
      status: get(header.columns.status),
      videoNum: get(header.columns.videoNum),
      hook: get(header.columns.hook),
      topic,
    });
  }
  return {
    rows,
    headerRow: header.row + 1,
    columns: header.columns,
    truncated: sawBeyondLimit,
    fallbackColumns: Boolean(header.fallback),
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseSheetInput(input) {
  const raw = typeof input === 'object' && input !== null
    ? String(input.url || input.id || '').trim()
    : String(input || '').trim();
  const explicitTab = typeof input === 'object' && input !== null ? String(input.tab || '').trim() : '';
  let id = null;
  let gid = null;
  let isUrl = false;

  if (SHEET_ID_RE.test(raw)) id = raw;
  else {
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
      if (url.protocol !== 'https:' || !/(^|\.)google\.com$/i.test(url.hostname) || !match) throw new Error('invalid');
      id = match[1];
      isUrl = true;
      const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
      const gidValue = url.searchParams.get('gid') || hash.get('gid');
      if (gidValue !== null && /^\d+$/.test(gidValue)) gid = Number(gidValue);
    } catch {
      id = null;
    }
  }
  if (!id) throw new Error('Paste a valid Google Sheets URL or spreadsheet ID.');
  if (explicitTab.length > MAX_TAB_LENGTH || /[\u0000-\u001f]/.test(explicitTab)) throw new Error('Worksheet name is invalid.');
  return { id, gid, tab: explicitTab, url: isUrl ? raw : null, preferShared: isUrl };
}

function a1Tab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

function extractJson(stdout) {
  const text = String(stdout || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('gws returned an invalid response.');
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error('gws returned an invalid response.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('gws returned an invalid response.');
  if (data.error) throw new Error(String(data.error.message || data.error.status || 'Google rejected the request.'));
  return data;
}

function safeExecMessage(error, stderr = '') {
  if (error?.code === 'ENOENT') return GWS_SETUP_HINT;
  const source = String(stderr || error?.message || 'Google request failed')
    .replace(/https:\/\/accounts\.google\.com\/[^\s]+/gi, '[Google sign-in URL omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [credential omitted]')
    .replace(/(["']?(?:access_token|refresh_token|client_secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[credential omitted]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return source.slice(0, 500) || 'Google request failed.';
}

function accountState({ connected, canConnect, canSetup = false, canDisconnect = false, status, reason, nextAction, hint = '', email = '' }) {
  return {
    ok: true,
    connected: Boolean(connected),
    email: connected ? String(email || '') : '',
    canConnect: Boolean(canConnect),
    canSetup: Boolean(canSetup),
    canDisconnect: Boolean(canDisconnect),
    status,
    reason,
    nextAction,
    readOnly: true,
    sharedLinkAvailable: true,
    ...(hint ? { hint } : {}),
  };
}

function createStorySheets(deps = {}) {
  const execute = deps.execFile || systemExecFile;
  const fetchImpl = deps.fetchImpl || global.fetch;
  const readConfig = deps.readConfig || (() => ({}));
  const writeConfig = deps.writeConfig || (() => {});
  const gwsBinary = deps.gwsBinary || process.env.VIDMYO_GWS_PATH || 'gws';
  const nativeGoogle = deps.nativeGoogle || null;

  async function nativeStatus() {
    if (!nativeGoogle) return null;
    try { return await nativeGoogle.account(); }
    catch { return null; }
  }

  function execGws(args, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      execute(gwsBinary, args, {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter),
        },
      }, (error, stdout = '', stderr = '') => {
        if (error) {
          const wrapped = new Error(safeExecMessage(error, stderr));
          wrapped.code = error.code;
          reject(wrapped);
        } else resolve(String(stdout));
      });
    });
  }

  async function gwsJson(args, options) {
    return extractJson(await execGws([...args, '--format', 'json'], options));
  }

  async function account() {
    const native = await nativeStatus();
    if (native?.connected) {
      return accountState({ connected: true, canConnect: true, canSetup: true, canDisconnect: true, status: ACCOUNT_STATE.CONNECTED,
        reason: 'connected', nextAction: ACCOUNT_ACTION.BROWSE, email: native.email });
    }
    if (native?.available && native?.configured) {
      return accountState({ connected: false, canConnect: true, canSetup: true, canDisconnect: false, status: ACCOUNT_STATE.CONNECT_READY,
        reason: native.reason || 'signed-out', nextAction: ACCOUNT_ACTION.CONNECT,
        hint: 'Click Connect Google to sign in for read-only access, or use a Viewer shared link below.' });
    }
    try {
      const status = extractJson(await execGws(['auth', 'status']));
      const connected = Boolean(status.token_valid && (status.has_refresh_token || status.auth_method));
      const canConnect = Boolean(status.client_config_exists);
      if (connected) {
        return accountState({
          connected: true,
          canConnect,
          canSetup: Boolean(native?.available),
          canDisconnect: false,
          status: ACCOUNT_STATE.CONNECTED,
          reason: 'connected',
          nextAction: ACCOUNT_ACTION.BROWSE,
          email: status.user || status.account || status.email,
        });
      }
      if (canConnect) {
        return accountState({
          connected: false,
          canConnect: true,
          status: ACCOUNT_STATE.CONNECT_READY,
          reason: 'signed-out',
          nextAction: ACCOUNT_ACTION.CONNECT,
          hint: 'Click Connect Google to sign in for read-only access, or use a Viewer shared link below.',
        });
      }
      return accountState({
        connected: false,
        canConnect: false,
        status: ACCOUNT_STATE.SETUP_REQUIRED,
        reason: 'oauth-client-missing',
        nextAction: ACCOUNT_ACTION.SHARED_LINK,
        hint: OAUTH_SETUP_HINT,
      });
    } catch (error) {
      const missing = error.code === 'ENOENT' || error.message === GWS_SETUP_HINT;
      const nativeSetup = Boolean(native?.available && !native?.configured);
      return accountState({
        connected: false,
        canConnect: false,
        canSetup: nativeSetup,
        canDisconnect: false,
        status: missing ? ACCOUNT_STATE.SETUP_REQUIRED : ACCOUNT_STATE.UNAVAILABLE,
        reason: nativeSetup ? 'oauth-client-missing' : (missing ? 'gws-missing' : 'account-check-failed'),
        nextAction: missing ? ACCOUNT_ACTION.SHARED_LINK : ACCOUNT_ACTION.RETRY,
        hint: nativeSetup ? OAUTH_SETUP_HINT : (missing ? GWS_SETUP_HINT : `Google connection could not be checked. ${error.message}`),
      });
    }
  }

  async function connect() {
    const native = await nativeStatus();
    if (native?.available && native?.configured) {
      const result = await nativeGoogle.connect();
      if (!result.ok) return { ...(await account()), ok: false, error: result.error || 'Google sign-in did not complete.' };
      return account();
    }
    const before = await account();
    if (!before.canConnect) {
      return { ...before, ok: false, error: before.hint || GWS_SETUP_HINT };
    }
    try {
      // This is reached only from the explicit Connect Google button. `gws`
      // opens the system browser and stores the resulting token in its keyring.
      await execGws(['auth', 'login', '--readonly', '--services', 'drive,sheets'], { timeout: 5 * 60 * 1000 });
      const after = await account();
      if (!after.connected) {
        return {
          ...after,
          ok: false,
          error: after.hint || 'Google sign-in did not complete. Try Connect Google again.',
        };
      }
      return after;
    } catch (error) {
      return {
        ...accountState({
          connected: false,
          canConnect: true,
          status: ACCOUNT_STATE.CONNECT_READY,
          reason: 'login-failed',
          nextAction: ACCOUNT_ACTION.CONNECT,
          hint: 'Google sign-in did not complete. Try Connect Google again, or use a Viewer shared link.',
        }),
        ok: false,
        error: `Google sign-in did not complete. ${error.message}`,
      };
    }
  }

  async function listSheets(pageToken) {
    try {
      if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > MAX_PAGE_TOKEN || /[\u0000-\u001f]/.test(pageToken))) {
        throw new Error('Spreadsheet page token is invalid. Refresh the spreadsheet list.');
      }
      const params = {
        q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
        spaces: 'drive',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        fields: 'nextPageToken,files(id,name)',
        ...(pageToken ? { pageToken } : {}),
      };
      const native = await nativeStatus();
      let data;
      if (native?.connected) {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
        data = await nativeGoogle.apiJson(url.toString());
      } else data = await gwsJson(['drive', 'files', 'list', '--params', JSON.stringify(params)]);
      const files = Array.isArray(data.files) ? data.files
        .filter((file) => SHEET_ID_RE.test(String(file?.id || '')))
        .map((file) => ({ id: String(file.id), name: String(file.name || 'Untitled spreadsheet') })) : [];
      return { ok: true, files, nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
    } catch (error) {
      return fail(new Error(`Could not list Google Sheets. ${error.message}`));
    }
  }

  async function tabsFor(id) {
    if (!SHEET_ID_RE.test(String(id || ''))) throw new Error('Spreadsheet ID is invalid.');
    const params = {
      spreadsheetId: String(id),
      includeGridData: false,
      fields: 'properties.title,sheets.properties(sheetId,title,index,hidden)',
    };
    const native = await nativeStatus();
    let data;
    if (native?.connected) {
      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(params.spreadsheetId)}`);
      url.searchParams.set('includeGridData', 'false');
      url.searchParams.set('fields', params.fields);
      data = await nativeGoogle.apiJson(url.toString());
    } else data = await gwsJson(['sheets', 'spreadsheets', 'get', '--params', JSON.stringify(params)]);
    const tabs = (Array.isArray(data.sheets) ? data.sheets : [])
      .map((sheet) => sheet?.properties)
      .filter((properties) => properties && Number.isInteger(properties.sheetId) && typeof properties.title === 'string')
      .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
      .map((properties) => ({ sheetId: properties.sheetId, title: properties.title }));
    return { ok: true, title: String(data.properties?.title || ''), tabs };
  }

  async function choose(input) {
    try {
      const selection = parseSheetInput(input);
      if (selection.gid !== null || selection.tab) {
        try {
          const metadata = await tabsFor(selection.id);
          const match = selection.tab
            ? metadata.tabs.find((tab) => tab.title === selection.tab)
            : metadata.tabs.find((tab) => tab.sheetId === selection.gid);
          if (match) {
            selection.tab = match.title;
            selection.gid = match.sheetId;
          } else if (selection.tab) {
            throw new Error(`Worksheet “${selection.tab}” was not found.`);
          }
        } catch (error) {
          // A Viewer link remains usable without gws metadata. An explicit tab
          // title is valid A1 notation; a gid remains valid for CSV export.
          if (!selection.preferShared) throw error;
        }
      }
      const config = readConfig() || {};
      config.googleSheetSelection = selection;
      writeConfig(config);
      return {
        ok: true,
        sheetId: selection.id,
        tab: selection.tab || '',
        gid: Number.isInteger(selection.gid) ? selection.gid : null,
        via: selection.preferShared ? 'shared-link' : 'google-account',
      };
    } catch (error) {
      return fail(error);
    }
  }

  function selected() {
    try {
      const selection = readConfig()?.googleSheetSelection;
      if (!selection || !SHEET_ID_RE.test(String(selection.id || ''))) {
        return { ok: true, id: null, tab: '', gid: null, via: null };
      }
      return {
        ok: true,
        id: String(selection.id),
        tab: String(selection.tab || ''),
        gid: Number.isInteger(selection.gid) ? selection.gid : null,
        via: selection.preferShared ? 'shared-link' : 'google-account',
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function readPublic(selection) {
    if (typeof fetchImpl !== 'function') throw new Error('Shared-link reading is unavailable in this runtime.');
    const url = new URL(`https://docs.google.com/spreadsheets/d/${selection.id}/gviz/tq`);
    url.searchParams.set('tqx', 'out:csv');
    url.searchParams.set('range', `A1:ZZ${READ_END_ROW}`);
    if (selection.gid !== null && selection.gid !== undefined) url.searchParams.set('gid', String(selection.gid));
    else if (selection.tab) url.searchParams.set('sheet', selection.tab);
    const response = await fetchImpl(url.toString(), { redirect: 'follow' });
    const text = await response.text();
    if (!response.ok || /^\s*</.test(text) || /<html[\s>]/i.test(text.slice(0, 500))) {
      throw new Error('The shared link is not readable. In Google Sheets, set General access to “Anyone with the link” and Viewer.');
    }
    return parseCsv(text);
  }

  async function readAuthenticated(selection) {
    const tab = selection.tab ? `${a1Tab(selection.tab)}!` : '';
    const params = {
      spreadsheetId: selection.id,
      range: `${tab}A1:ZZ${READ_END_ROW}`,
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    };
    const native = await nativeStatus();
    let data;
    if (native?.connected) {
      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(params.spreadsheetId)}/values/${encodeURIComponent(params.range)}`);
      url.searchParams.set('majorDimension', params.majorDimension);
      url.searchParams.set('valueRenderOption', params.valueRenderOption);
      data = await nativeGoogle.apiJson(url.toString());
    } else data = await gwsJson(['sheets', 'spreadsheets', 'values', 'get', '--params', JSON.stringify(params)]);
    return Array.isArray(data.values) ? data.values : [];
  }

  async function readSelected() {
    try {
      const selection = readConfig()?.googleSheetSelection;
      if (!selection || !SHEET_ID_RE.test(String(selection.id || ''))) {
        throw new Error('Choose a spreadsheet and worksheet first.');
      }
      let values;
      let via;
      let firstError;
      const attempts = selection.preferShared
        ? [['shared-link', readPublic], ['google-account', readAuthenticated]]
        : [['google-account', readAuthenticated], ...(selection.url ? [['shared-link', readPublic]] : [])];
      for (const [candidateVia, reader] of attempts) {
        try {
          values = await reader(selection);
          via = candidateVia;
          break;
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
      if (!values) throw firstError || new Error('The spreadsheet could not be read.');
      const mapped = mapSheetRows(values);
      return {
        ok: true,
        sheetId: selection.id,
        tab: selection.tab || '',
        rows: mapped.rows,
        via,
        limit: ROW_LIMIT,
        truncated: mapped.truncated,
      };
    } catch (error) {
      return fail(new Error(`Could not read the worksheet. ${error.message}`));
    }
  }

  function register(ipcMain) {
    ipcMain.handle('story:google-account', () => account());
    ipcMain.handle('story:google-connect', () => connect());
    ipcMain.handle('story:google-setup', async () => {
      if (!nativeGoogle) return { ...(await account()), ok: false, error: OAUTH_SETUP_HINT };
      const result = await nativeGoogle.setup();
      if (!result.ok) return { ...(await account()), ...result };
      return account();
    });
    ipcMain.handle('story:google-disconnect', async () => {
      if (!nativeGoogle) return { ...(await account()), ok: false, error: 'Native Google is not configured.' };
      const native = await nativeStatus();
      if (!native?.connected) {
        return { ...(await account()), ok: false, error: 'This account is managed by the legacy gws helper and must be disconnected there.' };
      }
      const result = await nativeGoogle.disconnect();
      return result.ok ? account() : result;
    });
    ipcMain.handle('story:google-sheets', (_event, pageToken) => listSheets(pageToken));
    ipcMain.handle('story:sheet-tabs', async (_event, id) => {
      try { return await tabsFor(id); }
      catch (error) { return fail(new Error(`Could not load worksheet tabs. ${error.message}`)); }
    });
    ipcMain.handle('story:choose-sheet', (_event, input) => choose(input));
    ipcMain.handle('story:selected-sheet', () => selected());
    ipcMain.handle('story:read-sheet', () => readSelected());
  }

  return { register, account, connect, listSheets, tabsFor, choose, selected, readSelected };
}

module.exports = {
  createStorySheets,
  parseSheetInput,
  parseCsv,
  mapSheetRows,
  normalizeHeader,
  GWS_SETUP_HINT,
  OAUTH_SETUP_HINT,
};
