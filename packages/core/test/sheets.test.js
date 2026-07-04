import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetIdFromInput, parseCsv, trackerRows, readSheetValues } from '../src/sheets.js';

test('sheetIdFromInput accepts URLs and bare ids, rejects junk', () => {
  assert.equal(
    sheetIdFromInput('https://docs.google.com/spreadsheets/d/1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo/edit#gid=0'),
    '1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo',
  );
  assert.equal(sheetIdFromInput('1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo'), '1ZrdLMkdC1-OXxaPwgMGZW7dUO9bSNcQRNETP7D5d4jo');
  assert.equal(sheetIdFromInput('not a sheet'), null);
});

test('parseCsv handles quotes, embedded commas, and newlines in cells', () => {
  const rows = parseCsv('a,"b, with comma","line1\nline2"\n"has ""quote""",x,y\n');
  assert.deepEqual(rows[0], ['a', 'b, with comma', 'line1\nline2']);
  assert.deepEqual(rows[1], ['has "quote"', 'x', 'y']);
});

test('trackerRows maps A:E and keeps 1-based sheet row numbers', () => {
  const rows = trackerRows([
    ['Status', 'Video #', 'Working Title', 'Hook', 'Topic'],
    ['Published', '1', 'Why You Wake Up', 'hook', 'sleep'],
    ['', '', '', '', ''],               // blank row: filtered (no title)
    ['Planned', '3', 'Mouse Utopia', 'h', 't'],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row, 2);
  assert.equal(rows[1].row, 5 - 1); // row 4 in the sheet
  assert.equal(rows[1].status, 'Planned');
});

test('readSheetValues prefers the public CSV path', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => 'Status,Video #\nPlanned,1\n' });
  const res = await readSheetValues('x'.repeat(24), 'A1:E2', { fetchImpl });
  assert.equal(res.via, 'public-link');
  assert.deepEqual(res.values[1], ['Planned', '1']);
});

test('readSheetValues detects the HTML login page and falls through', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => '<!DOCTYPE html><html>login</html>' });
  // gws will fail for a nonsense id — we only assert the combined error shape.
  await assert.rejects(
    readSheetValues('x'.repeat(24), 'A1:B2', { fetchImpl }),
    /Could not read the sheet/,
  );
});
