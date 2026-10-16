import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createStorySheets,
  parseSheetInput,
  parseCsv,
  mapSheetRows,
  GWS_SETUP_HINT,
  OAUTH_SETUP_HINT,
} = require('../../../electron/lib/storySheets.js');
const { requireProjectDirectory } = require('../../../electron/lib/storyBridge.js');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function makeHarness({ responder, fetchImpl, initialConfig = {} } = {}) {
  let config = structuredClone(initialConfig);
  const calls = [];
  const handlers = new Map();
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const result = responder ? responder({ command, args, options, calls }) : {};
    queueMicrotask(() => {
      if (result?.error) callback(result.error, result.stdout || '', result.stderr || '');
      else callback(null, typeof result?.stdout === 'string' ? result.stdout : JSON.stringify(result?.stdout || {}), result?.stderr || '');
    });
    return { kill() {} };
  };
  const bridge = createStorySheets({
    execFile,
    fetchImpl,
    readConfig: () => config,
    writeConfig: (next) => { config = structuredClone(next); },
  });
  bridge.register({ handle: (name, handler) => handlers.set(name, handler) });
  return { bridge, calls, handlers, config: () => config };
}

test('parses IDs, shared links, gid fragments, tabs, and RFC CSV cells', () => {
  assert.deepEqual(parseSheetInput(ID), { id: ID, gid: null, tab: '', url: null, preferShared: false });
  const link = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`;
  assert.deepEqual(parseSheetInput(link), { id: ID, gid: 42, tab: '', url: link, preferShared: true });
  assert.equal(parseSheetInput({ id: ID, tab: "Director's cut" }).tab, "Director's cut");
  assert.throws(() => parseSheetInput('https://example.com/spreadsheets/d/' + ID), /valid Google Sheets/);
  assert.deepEqual(parseCsv('Title,Description\n"One, two","line 1\nline 2"\n'), [
    ['Title', 'Description'],
    ['One, two', 'line 1\nline 2'],
  ]);
});

test('maps common headers, preserves physical row numbers, and keeps Curio/Superius fallback', () => {
  const generic = mapSheetRows([
    ['Notes'],
    ['Production Status', 'Video #', 'Video Title', 'Opening Hook', 'Description'],
    ['Planned', '8', 'Why ravens remember', 'They know you', 'Memory and recognition'],
    ['', '', '', '', ''],
    ['Draft', '9', 'Fox experiment', '', 'Domestication'],
  ]);
  assert.deepEqual(generic.rows, [
    { row: 3, title: 'Why ravens remember', status: 'Planned', videoNum: '8', hook: 'They know you', topic: 'Memory and recognition' },
    { row: 5, title: 'Fox experiment', status: 'Draft', videoNum: '9', hook: '', topic: 'Domestication' },
  ]);
  assert.equal(generic.headerRow, 2);

  const legacy = mapSheetRows([
    ['Workflow', 'Ordinal', 'Headline copy', 'Lead sentence', 'Creative angle'],
    ['Ready', '2', 'A working title', 'Opening', 'Angle'],
  ]);
  assert.equal(legacy.fallbackColumns, true);
  assert.equal(legacy.rows[0].title, 'A working title');
  assert.equal(legacy.rows[0].row, 2);
});

test('caps row results at 1,000 and reports overflow', () => {
  const values = [['Title'], ...Array.from({ length: 1001 }, (_, index) => [`Title ${index + 1}`])];
  const mapped = mapSheetRows(values);
  assert.equal(mapped.rows.length, 1000);
  assert.equal(mapped.rows.at(-1).row, 1001);
  assert.equal(mapped.truncated, true);
});

test('registers the exact window.story Google IPC contract', () => {
  const { handlers } = makeHarness();
  assert.deepEqual([...handlers.keys()].sort(), [
    'story:choose-sheet',
    'story:google-account',
    'story:google-connect',
    'story:google-disconnect',
    'story:google-setup',
    'story:google-sheets',
    'story:read-sheet',
    'story:selected-sheet',
    'story:sheet-tabs',
  ]);
});

test('reports connected account and lists paginated spreadsheets through read-only API methods', async () => {
  const { handlers, calls } = makeHarness({ responder: ({ args }) => {
    if (args[0] === 'auth') return { stdout: `Using keyring backend: keyring\n${JSON.stringify({ token_valid: true, has_refresh_token: true, client_config_exists: true, user: 'reader@example.com' })}` };
    if (args.includes('files')) return { stdout: { files: [{ id: ID, name: 'Editorial calendar' }], nextPageToken: 'next-2' } };
    throw new Error(`unexpected call ${args.join(' ')}`);
  } });
  assert.deepEqual(await handlers.get('story:google-account')(), {
    ok: true,
    connected: true,
    email: 'reader@example.com',
    canConnect: true,
    canSetup: false,
    canDisconnect: false,
    status: 'connected',
    reason: 'connected',
    nextAction: 'browse-private-sheets',
    readOnly: true,
    sharedLinkAvailable: true,
  });
  assert.deepEqual(await handlers.get('story:google-sheets')(null, 'page-1'), {
    ok: true, files: [{ id: ID, name: 'Editorial calendar' }], nextPageToken: 'next-2',
  });
  const params = JSON.parse(calls.at(-1).args[calls.at(-1).args.indexOf('--params') + 1]);
  assert.equal(params.pageToken, 'page-1');
  assert.match(params.q, /spreadsheet/);
  assert.equal(calls.at(-1).args.includes('--json'), false);
});

test('Connect Google uses the explicit read-only Drive + Sheets login and rechecks the account', async () => {
  let statusCalls = 0;
  const { bridge, calls } = makeHarness({ responder: ({ args }) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      statusCalls += 1;
      return { stdout: { token_valid: statusCalls > 1, has_refresh_token: statusCalls > 1, client_config_exists: true, user: 'reader@example.com' } };
    }
    if (args[0] === 'auth' && args[1] === 'login') return { stdout: { account: 'reader@example.com' } };
    throw new Error('unexpected call');
  } });
  const result = await bridge.connect();
  assert.equal(result.ok, true);
  assert.equal(result.connected, true);
  assert.deepEqual(calls[1].args, ['auth', 'login', '--readonly', '--services', 'drive,sheets']);
});

test('resolves gid to worksheet title and reads a shared link without Google auth', async () => {
  const sharedCsv = 'Status,Video #,Working Title,Hook,Topic/Angle\nPlanned,3,Mouse Utopia,The perfect world,Behavioral collapse\n';
  const { bridge, config, calls } = makeHarness({
    responder: ({ args }) => {
      if (args.includes('spreadsheets') && args.includes('get')) {
        return { stdout: { properties: { title: 'Curio tracker' }, sheets: [
          { properties: { sheetId: 0, title: 'Archive', index: 0 } },
          { properties: { sheetId: 42, title: 'Queue', index: 1 } },
        ] } };
      }
      throw new Error(`unexpected call ${args.join(' ')}`);
    },
    fetchImpl: async (url) => ({ ok: true, text: async () => sharedCsv, url }),
  });
  const chosen = await bridge.choose(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`);
  assert.deepEqual(chosen, { ok: true, sheetId: ID, tab: 'Queue', gid: 42, via: 'shared-link' });
  assert.equal(config().googleSheetSelection.gid, 42);
  assert.equal(config().googleSheetSelection.tab, 'Queue');
  const result = await bridge.readSelected();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'shared-link');
  assert.equal(result.rows[0].row, 2);
  assert.equal(result.rows[0].title, 'Mouse Utopia');
  assert.equal(calls.filter((call) => call.args.includes('values')).length, 0);
});

test('reads a selected account spreadsheet using quoted A1 tab notation', async () => {
  const { bridge, calls } = makeHarness({ responder: ({ args }) => {
    if (args.includes('values')) {
      return { stdout: { values: [['Status', 'Numer filmu', 'Tytuł roboczy', 'Haczyk', 'Opis'], ['Plan', '1', 'Pamięć kruków', 'One pamiętają', 'Nauka']] } };
    }
    if (args.includes('spreadsheets') && args.includes('get')) {
      return { stdout: { properties: { title: 'Superiusz' }, sheets: [{ properties: { sheetId: 7, title: "Editor's Queue", index: 0 } }] } };
    }
    throw new Error(`unexpected call ${args.join(' ')}`);
  } });
  assert.equal((await bridge.choose({ id: ID, tab: "Editor's Queue" })).ok, true);
  const result = await bridge.readSelected();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'google-account');
  assert.equal(result.rows[0].title, 'Pamięć kruków');
  const valuesCall = calls.find((call) => call.args.includes('values'));
  const params = JSON.parse(valuesCall.args[valuesCall.args.indexOf('--params') + 1]);
  assert.equal(params.range, "'Editor''s Queue'!A1:ZZ1002");
  assert.equal(valuesCall.args.includes('--json'), false);
});

test('gives an actionable missing-gws state and rejects malformed page tokens', async () => {
  const missing = Object.assign(new Error('spawn gws ENOENT'), { code: 'ENOENT' });
  const { bridge } = makeHarness({ responder: () => ({ error: missing }) });
  const account = await bridge.account();
  assert.equal(account.ok, true);
  assert.equal(account.connected, false);
  assert.equal(account.canConnect, false);
  assert.equal(account.status, 'setup-required');
  assert.equal(account.reason, 'gws-missing');
  assert.equal(account.nextAction, 'use-viewer-link');
  assert.equal(account.readOnly, true);
  assert.equal(account.sharedLinkAvailable, true);
  assert.equal(account.hint, GWS_SETUP_HINT);
  const list = await bridge.listSheets('bad\nvalue');
  assert.equal(list.ok, false);
  assert.match(list.error, /page token is invalid/);
});

test('legacy Story create/get paths require explicit valid folders and protect manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-story-path-'));
  const project = path.join(root, 'project');
  const ordinaryFile = path.join(root, 'ordinary-file');
  fs.mkdirSync(project);
  fs.writeFileSync(ordinaryFile, 'x');

  assert.throws(() => requireProjectDirectory('relative/path'), /absolute project folder/);
  assert.throws(() => requireProjectDirectory(path.join(root, 'missing')), /does not exist/);
  assert.throws(() => requireProjectDirectory(ordinaryFile), /not a folder/);
  assert.throws(() => requireProjectDirectory(project), /not a Vidmyo Story project/);
  assert.equal(requireProjectDirectory(project, { creating: true }), project);

  fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ version: 1 }));
  assert.equal(requireProjectDirectory(project), project);
  assert.throws(() => requireProjectDirectory(project, { creating: true }), /Refusing to overwrite existing manifest/);
});

test('falls back from an unreadable shared export to the connected account', async () => {
  const { bridge } = makeHarness({
    fetchImpl: async () => ({ ok: true, text: async () => '<!doctype html><html>Google sign in</html>' }),
    responder: ({ args }) => {
      if (args.includes('values')) return { stdout: { values: [['Title', 'Hook'], ['Private row', 'Opening']] } };
      throw new Error(`unexpected call ${args.join(' ')}`);
    },
  });
  await bridge.choose(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
  const result = await bridge.readSelected();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'google-account');
  assert.equal(result.rows[0].title, 'Private row');
});

test('distinguishes missing OAuth client from a signed-out account and blocks login before browser launch', async () => {
  const noClient = makeHarness({ responder: ({ args }) => {
    assert.deepEqual(args, ['auth', 'status']);
    return { stdout: { token_valid: false, has_refresh_token: false, client_config_exists: false } };
  } });
  const missingClient = await noClient.bridge.account();
  assert.equal(missingClient.status, 'setup-required');
  assert.equal(missingClient.reason, 'oauth-client-missing');
  assert.equal(missingClient.nextAction, 'use-viewer-link');
  assert.equal(missingClient.hint, OAUTH_SETUP_HINT);
  const blocked = await noClient.bridge.connect();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'oauth-client-missing');
  assert.equal(blocked.error, OAUTH_SETUP_HINT);
  assert.equal(noClient.calls.every((call) => call.args[1] === 'status'), true);

  const signedOut = makeHarness({ responder: () => ({
    stdout: { token_valid: false, has_refresh_token: false, client_config_exists: true },
  }) });
  const ready = await signedOut.bridge.account();
  assert.equal(ready.status, 'connect-ready');
  assert.equal(ready.reason, 'signed-out');
  assert.equal(ready.nextAction, 'connect-google');
  assert.equal(ready.canConnect, true);
});

test('reopens a saved Viewer selection and reads it when gws is absent', async () => {
  const missing = Object.assign(new Error('spawn gws ENOENT'), { code: 'ENOENT' });
  const first = makeHarness({ responder: () => ({ error: missing }) });
  const link = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`;
  const chosen = await first.bridge.choose(link);
  assert.deepEqual(chosen, { ok: true, sheetId: ID, tab: '', gid: 42, via: 'shared-link' });

  const reopened = makeHarness({
    initialConfig: first.config(),
    responder: () => ({ error: missing }),
    fetchImpl: async () => ({ ok: true, text: async () => 'Title,Description\nReopened row,Still readable\n' }),
  });
  assert.deepEqual(reopened.bridge.selected(), { ok: true, id: ID, tab: '', gid: 42, via: 'shared-link' });
  const result = await reopened.bridge.readSelected();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'shared-link');
  assert.equal(result.rows[0].title, 'Reopened row');
  assert.equal(reopened.calls.length, 0);
});

test('redacts credential-shaped stderr from Google errors', async () => {
  const error = Object.assign(new Error('auth failed'), { code: 2 });
  const { bridge } = makeHarness({ responder: () => ({
    error,
    stderr: 'Bearer abc.def_ghi "refresh_token":"secret-value" client_secret=another-secret',
  }) });
  const result = await bridge.listSheets();
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /abc\.def_ghi|secret-value|another-secret/);
  assert.match(result.error, /credential omitted/);
});
