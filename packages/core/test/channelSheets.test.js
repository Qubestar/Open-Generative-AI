import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ChannelWorkspace, createChannelManifest, TRACKER_COLUMNS } from '../index.js';

const require = createRequire(import.meta.url);
const { createChannelSheets, META_COLUMNS } = require('../../../electron/lib/channelSheets.js');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function fixedClock() { return () => new Date('2026-09-22T12:00:00.000Z'); }

function ids() {
  let index = 0;
  return prefix => `${prefix}_test${++index}`;
}

function trackerHarness() {
  const writes = [];
  const sheet = { id: ID, title: '', videos: [], metadata: [] };
  const google = {
    writeJson: async (url, options) => {
      writes.push({ url, options: structuredClone(options) });
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
        sheet.title = options.body.properties.title;
        return { spreadsheetId: ID, properties: { title: sheet.title } };
      }
      assert.equal(url, `https://sheets.googleapis.com/v4/spreadsheets/${ID}/values:batchUpdate`);
      for (const update of options.body.data) {
        if (update.range === 'Videos!A1') sheet.videos = structuredClone(update.values);
        if (update.range === "'_Vidmyo'!A1") sheet.metadata = structuredClone(update.values);
      }
      return { totalUpdatedCells: 1 };
    },
    apiJson: async (url) => {
      assert.match(url, new RegExp(`/v4/spreadsheets/${ID}/values:batchGet`));
      return { spreadsheetId: ID, valueRanges: [{ values: structuredClone(sheet.videos) }, { values: structuredClone(sheet.metadata) }] };
    },
  };
  return { sheet, writes, service: createChannelSheets({ google, core: () => import('../index.js') }) };
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo-channel-sheets-'));
  const options = { clock: fixedClock(), idGenerator: ids() };
  const manifest = createChannelManifest({ name: 'Curio' }, options);
  const result = ChannelWorkspace.create(root, manifest, options);
  result.addVideo({ title: 'The first tracker video', status: 'ready', hook: 'Start here' });
  return { root, workspace: result };
}

test('creates a private tracker with the exact visible tracker and hidden stable metadata', async () => {
  const h = trackerHarness();
  const w = workspace();
  try {
    const result = await h.service.create(w.workspace, { title: 'Curio tracker' });
    assert.deepEqual(result, { ok: true, spreadsheetId: ID, title: 'Curio tracker', rows: 1, action: 'created' });
    assert.deepEqual(h.sheet.videos[0], TRACKER_COLUMNS);
    assert.equal(h.sheet.videos[0].length, 21);
    assert.deepEqual(h.sheet.metadata[0], META_COLUMNS);
    assert.equal(h.sheet.metadata[1].length, 4);
    assert.equal(w.workspace.snapshot().tracker.sheetId, ID);
    assert.equal(w.workspace.snapshot().videos[0].sheet.lastKnownRow, 2);
    assert.equal(h.writes[0].options.body.sheets[1].properties.hidden, true);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('pull imports a remote-only edit and advances the hidden sync baseline', async () => {
  const h = trackerHarness();
  const w = workspace();
  try {
    await h.service.create(w.workspace);
    h.sheet.videos[1][2] = 'Edited in Google Sheets';
    const pulled = await h.service.pull(w.workspace);
    assert.equal(pulled.ok, true);
    assert.equal(pulled.action, 'pulled');
    assert.equal(w.workspace.snapshot().videos[0].title, 'Edited in Google Sheets');
    assert.equal(h.sheet.metadata[1][2], '1');
    assert.notEqual(h.sheet.metadata[1][3], '');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('push sends local changes but reports divergent Google edits without overwriting them', async () => {
  const h = trackerHarness();
  const w = workspace();
  try {
    await h.service.create(w.workspace);
    const video = w.workspace.snapshot().videos[0];
    w.workspace.updateVideo(video.id, { title: 'Local edit' });
    const pushed = await h.service.push(w.workspace);
    assert.equal(pushed.action, 'pushed');
    assert.equal(h.sheet.videos[1][2], 'Local edit');

    w.workspace.updateVideo(video.id, { title: 'Second local edit' });
    h.sheet.videos[1][2] = 'Conflicting Google edit';
    const conflict = await h.service.push(w.workspace);
    assert.deepEqual(conflict, {
      ok: false, conflict: true, code: 'tracker-conflict', conflicts: [video.id], conflictsTruncated: false,
      spreadsheetId: ID, title: '', rows: 1, action: 'push',
    });
    assert.equal(h.sheet.videos[1][2], 'Conflicting Google edit');
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});
